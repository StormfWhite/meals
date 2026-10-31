"""Bulk makes: a big pot of something (beans, stock, sauce, granola) put straight into the
fridge, the dry shelf or the freezer, and drawn from later as an INGREDIENT of meals.

Storm 2026-10-25: "a new bulk make tab that goes straight into pantry/freezer/fridge that makes
large portions of things that can be drawn from later as an ingredient with all the internal
ingredients from the bulk make for the nutrition data".

What's made is an ordinary ingredient carrying `made: {yield_g, unit}`; its nutrition is never
looked up (no USDA match) -- it's the sum of what went into the pot, spread over what came out
(`per100`). "1 cup black beans" on a meal is then 1/N of the pot's nutrients when the pot was
said to make N cups.

A make is an event in stock.json `makes` (like a correction): on its date its lines come out of
what's on hand (stock.Ledger, oldest first, freezer last) and `yield_g` of the product goes in.
Whatever the kitchen doesn't have of the lines lands on that week's list (`Ledger.make_short`).
Undo marks it `undone` -- it stops counting, but stays the recipe the next make starts from.

How much comes out (`parse_yield`):
  "3 lb" / "1.5 kg"            weighed: that's the weight
  "6 blocks of 1 lb", "4 x 32 oz jars"   that many of that size
  "8 cups" / "4 qt" / "2 l"    a volume: the pot weighs what it's estimated to, a cup is 1/8 of it
  "12 servings" / "6 jars"     a count: the same, one of them is 1/12 of the pot
  blank                        the estimate (`estimate`): weight AND cups, worked out from the lines

The estimate (Storm 2026-10-26: "shouldn't bulk auto determine based on the ingredient how many
cups, oz, lb, etc it made?"): every line cooked -- dry lentils, beans, rice, pasta, oats take up
water (from the pot's listed water/broth first, else water that wasn't written down), greens and
softened vegetables shrink -- then each line's cooked volume (its own cup weight, else water's).
Kitchen yields, a fixed table; a said weight or volume always wins.
"""
from __future__ import annotations

import datetime
import re
import time
import uuid
from typing import Optional

from . import ingredients, nutrition, store

PLACES = ("fridge", "pantry", "freezer")
FRIDGE_KEEP_DAYS = 5          # cooked food in the fridge; past it the replay freezes it
PANTRY_KEEP_DAYS = 60         # a dry make (granola, spice mix)


def _stock_file():
    from . import stock
    return stock.STOCK_FILE


def _load() -> list[dict]:
    return store.load(_stock_file(), {}).get("makes", [])


def _num(text: str) -> Optional[float]:
    """ "2", "1.5", "1/2", "2 1/2" -> a number."""
    t = (text or "").strip()
    m = re.fullmatch(r"(\d*\.?\d+)?\s*(?:(\d+)\s*/\s*(\d+))?", t)
    if not t or not m or not (m.group(1) or m.group(2)):
        return None
    n = float(m.group(1)) if m.group(1) else 0.0
    if m.group(2) and float(m.group(3) or 0):
        n += float(m.group(2)) / float(m.group(3))
    return n


def _unit_word(word: str) -> str:
    from . import stock
    w = word.strip().lower().rstrip(".")
    if w in stock.PACKS:
        return stock.PACKS[w]
    w = nutrition.UNIT_ALIASES.get(w, w)
    if w.endswith("ies"):
        return w[:-3] + "y"
    return w[:-1] if w.endswith("s") and not w.endswith("ss") and len(w) > 2 else w


# what cooking does to a line: (name/USDA-description pattern, cooked weight per raw gram, grams in
# a cup of it cooked). Sources: 1 cup dry lentils (192 g) -> 2.5 cups cooked (198 g each); dry
# beans/chickpeas ~185 g -> 3 cups (172 g); white rice 185 g -> 3 cups (158 g); quinoa 170 g ->
# 3 cups (185 g); 2 oz dry pasta -> 1 cup (140 g); 1 cup oats (81 g) -> ~2 cups oatmeal (234 g);
# 10 oz raw spinach -> ~1.5 cups cooked (180 g); sweated onions/peppers/mushrooms lose ~15% and
# pack ~210 g a cup.
COOKS = [
    (re.compile(r"\b(lentils?|split peas?)\b"), 2.58, 198.0),
    (re.compile(r"\b(beans?|chickpeas?|garbanzos?|black-eyed peas?)\b.*\b(dry|dried|mature seeds)\b|"
                r"\b(dry|dried)\b.*\b(beans?|chickpeas?|garbanzos?)\b"), 2.75, 172.0),
    (re.compile(r"\brice\b"), 2.56, 158.0),
    (re.compile(r"\bquinoa\b"), 3.26, 185.0),
    (re.compile(r"\b(pasta|spaghetti|penne|macaroni|noodles?|rotini|fusilli|orzo)\b"), 2.5, 140.0),
    (re.compile(r"\b(oats?|oatmeal)\b"), 2.9, 234.0),
    (re.compile(r"\b(spinach|kale|chard|collards?|arugula|greens)\b"), 0.9, 180.0),
    (re.compile(r"\b(onions?|shallots?|leeks?|mushrooms?|peppers?|zucchini|celery|cabbage|eggplant)\b"), 0.85, 210.0),
]
# already cooked or out of a can: it goes in as it is
_READY = re.compile(r"\b(cooked|canned|from canned|boiled|caramelized|sauteed|sautéed|roasted)\b")
_LIQUID = re.compile(r"\b(water|broth|stock|bouillon)\b")
WATER_CUP_G = 240.0


def _cooks(ing: dict) -> Optional[tuple[float, float]]:
    text = f"{ing.get('name') or ''} {ing.get('fdc_description') or ''}".lower()
    if _READY.search(text) or ing.get("made") or ing.get("from"):
        return None
    if re.search(r"\b(spices?|powder|ground|flakes)\b", text):
        return None                                 # dried oregano, chili powder: a pinch, as is
    return next(((w, cup) for rx, w, cup in COOKS if rx.search(text)), None)


def estimate(lines: list[dict], by_id: Optional[dict] = None) -> dict:
    """What the pot comes out as, from its lines: {g, cups, text, water_added_g}."""
    by_id = by_id or ingredients.by_id()
    solid_g = cups = liquid_g = soak_g = 0.0
    for item in lines:
        ing = by_id.get(item["ingredient_id"])
        if not ing:
            continue
        g = nutrition.qty_to_grams(ing, item.get("qty") or 0, item.get("unit") or "each") or 0.0
        if g <= 0:
            continue
        name = (ing.get("name") or "").lower()
        if _LIQUID.search(name) and not re.search(r"\b(powder|cubes?|paste)\b", name):
            liquid_g += g
            continue
        rule = _cooks(ing)
        if rule:
            w, cup_g = rule
            solid_g += g * w
            cups += g * w / cup_g
            soak_g += max(0.0, g * (w - 1))         # water it takes up (negative = what it gives off)
            continue
        own_cup = nutrition.qty_to_grams(ing, 1, "cup")
        solid_g += g
        cups += g / (own_cup or WATER_CUP_G)
    left = max(0.0, liquid_g - soak_g)              # the listed liquid goes into the dry things first
    total = solid_g + left
    cups += left / WATER_CUP_G
    text = f"{_round_cups(cups)} cups · {stock_amount(total)}" if total else ""
    return {"g": total, "cups": cups, "text": text, "water_added_g": max(0.0, soak_g - liquid_g)}


def _round_cups(c: float) -> str:
    r = round(c * 4) / 4 if c < 4 else round(c * 2) / 2 if c < 12 else round(c)
    return f"{r:g}"


def stock_amount(g: float) -> str:
    from . import stock
    return stock.us_amount(g)


def _one_yield(t: str, input_g: float) -> dict:
    """One part of what the pot makes ("8 cups", "3 lb", "6 blocks of 1 lb"); `weighed` = it says
    the pot's real weight."""
    from . import stock
    out = {"yield_g": input_g, "unit": None, "conversions": {}, "weighed": False}
    if not t:
        return out
    # several of one size: "6 blocks of 1 lb", "4 x 32 oz jars"
    m = stock.BLOCKS.match(t)
    if m and m.group(2).strip() and stock.size_g(m.group(2)):
        size, n = stock.size_g(m.group(2)), float(m.group(1))
        out.update(yield_g=n * size, unit={"word": "block", "g": size, "n": n}, weighed=True)
        out["conversions"]["block"] = size
        return out
    for rx, n_at, size_at, pack_at in stock.COUNT_SIZE:
        m = rx.match(t)
        if m and stock.size_g(m.group(size_at)):
            size, n = stock.size_g(m.group(size_at)), float(m.group(n_at))
            word = stock.PACKS.get((m.group(pack_at) or "").lower()) or "package"
            out.update(yield_g=n * size, unit={"word": word, "g": size, "n": n}, weighed=True)
            out["conversions"][word] = size
            return out
    m = re.match(r"^([\d./ ]*\d)\s*(.*)$", t)
    if not m or _num(m.group(1)) is None or _num(m.group(1)) <= 0:
        return out
    n, word = _num(m.group(1)), m.group(2).strip()
    # weighed
    if word in ("oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g", "gram", "grams", "kg"):
        g = stock.prices._parse_grams(f"{n} {word}")
        if g:
            out.update(yield_g=g, weighed=True)
            return out
    if not word:
        return out
    unit = "fl oz" if word.startswith("fl") else _unit_word(word)
    g_each = input_g / n if input_g else None
    out["unit"] = {"word": unit, "g": g_each, "n": n}
    if g_each:
        out["conversions"][unit] = g_each
        if unit in nutrition.TSP_PER:            # a volume: cups (and so every other volume) follow from it
            out["conversions"]["cup"] = input_g / (n * nutrition.TSP_PER[unit] / nutrition.TSP_PER["cup"])
    return out


def parse_yield(text: str, input_g: float, est: Optional[dict] = None) -> dict:
    """What the pot makes -> {yield_g, unit: {word, g, n} | None, text, conversions}. Nothing is
    saved here (the preview asks too); `conversions` are the units a meal line can then use.
    Several parts say several things (Storm 2026-10-25: "1 cup ... the right proportions"): in
    "8 cups, 3 lb" the weight is the pot's real weight and a cup is an eighth of it."""
    t = re.sub(r"\s+", " ", (text or "").strip().lower())
    if est and est.get("g"):
        if not t:                                # nothing said: the estimate, weight and cups
            return {"yield_g": est["g"], "unit": None, "text": "", "estimated": True,
                    "conversions": {"cup": est["g"] / est["cups"]} if est.get("cups") else {}}
        input_g = est["g"]                       # "8 cups" with no weight: the cooked pot's weight
    parts = [p for p in re.split(r"\s*(?:,|;|·|\+|=|\band\b)\s*", t) if p] or [""]
    first = [_one_yield(p, input_g) for p in parts]
    weighed = next((r for r in first if r["weighed"]), None)
    base = weighed["yield_g"] if weighed else input_g
    out = {"yield_g": base, "unit": weighed["unit"] if weighed else None, "text": text.strip() if text else "",
           "conversions": dict(weighed["conversions"]) if weighed else {}}
    for p, r in zip(parts, first):
        if r is weighed:
            continue
        r = _one_yield(p, base)                  # a count or a volume: measured against the real weight
        out["conversions"].update(r["conversions"])
        if r["unit"]:
            out["unit"] = r["unit"]
    return out


def lines_grams(lines: list[dict], by_id: Optional[dict] = None) -> float:
    by_id = by_id or ingredients.by_id()
    total = 0.0
    for item in lines:
        ing = by_id.get(item["ingredient_id"])
        if ing:
            total += nutrition.qty_to_grams(ing, item.get("qty") or 0, item.get("unit") or "each") or 0.0
    return total


def latest(ingredient_id: str, include_undone: bool = True) -> Optional[dict]:
    mine = [m for m in _load() if m["ingredient_id"] == ingredient_id and (include_undone or not m.get("undone"))]
    return max(mine, key=lambda m: (m["date"], m.get("at", 0))) if mine else None


_depth = 0


def per100(ing: dict) -> Optional[dict]:
    """Nutrients per 100 g of what came out of the pot: everything that went in (its latest
    make's lines), over the weight it made. None while nothing that went in is known."""
    global _depth
    made = latest(ing["id"])
    if not made or not made.get("yield_g") or _depth > 3:     # a make inside a make inside...: stop
        return None
    _depth += 1
    try:
        res = nutrition.recipe_totals({"ingredients": made["lines"], "servings": 1}, ingredients.by_id())
    finally:
        _depth -= 1
    if len(res["unknown_ingredients"]) == len(made["lines"]):
        return None
    # no weight said for the pot: it weighs what went in -- as weighed NOW, and only the lines
    # that count. Saved at make time it was 8 g (only the garlic weighed yet), so a lentil soup
    # read 8,874 kcal per 100 g once its lentils and onions could be weighed (2026-10-26).
    yield_g = made["yield_g"]
    if not parse_yield(made.get("yield_text") or "", 0.0)["yield_g"]:
        unknown = set(res["unknown_ingredients"])
        yield_g = estimate([l for l in made["lines"] if l["ingredient_id"] not in unknown])["g"] or yield_g
    k = 100.0 / yield_g
    tot = res["total"]
    out = {key: tot.get(key, 0.0) * k for key in nutrition.NUTRIENT_KEYS}
    out["vitamins"] = {key: v * k for key, v in (tot.get("vitamins") or {}).items()}
    out["unknown"] = res["unknown_ingredients"]
    return out


def make(name: str, lines: list[dict], yield_text: str, where: str, date: str, replace_id: Optional[str] = None) -> dict:
    """Make it: the product (an ingredient, made if new) gets the units the yield names, the
    make is recorded, and the replay does the rest. `replace_id` = EDIT that make in place (its lines, place, date,
    name) instead of recording another one -- changing a pot's info must not put a second pot in the kitchen."""
    from . import stock
    if where not in PLACES:
        raise ValueError("fridge, pantry or freezer")
    lines = [{"ingredient_id": l["ingredient_id"], "qty": float(l.get("qty") or 0),
              "unit": l.get("unit") or "each"} for l in lines if l.get("ingredient_id")]
    if not name.strip() or not lines:
        raise ValueError("a name and what goes in")
    by_id = ingredients.by_id()
    bare = next((l for l in lines if l["qty"] <= 0), None)
    if bare:    # it would go in as nothing, nutrition and all
        raise ValueError(f"how much {(by_id.get(bare['ingredient_id']) or {}).get('name', 'of a line')}?")
    input_g = lines_grams(lines, by_id)
    y = parse_yield(yield_text, input_g, estimate(lines, by_id))
    if not y["yield_g"]:
        raise ValueError("those lines have no weight to add up -- give each one an amount (\"2 cups\", \"1 lb\")")
    old = None
    if replace_id:
        old = next((m for m in _load() if m["id"] == replace_id), None)
        if old is None:
            raise ValueError("that pot isn't there any more")
        ing = ingredients.get(old["ingredient_id"])
        if ing and (ing.get("name") or "").strip().lower() != name.strip().lower():
            ing = ingredients.update(ing["id"], name=name.strip())          # renamed: still the same pot
    else:
        ing = ingredients.add(name.strip(), "other")
    if any(l["ingredient_id"] == ing["id"] for l in lines):
        raise ValueError("it can't go into itself")
    fields: dict = {"made": {"yield_g": y["yield_g"], "unit": y["unit"]},
                    "unit_conversions": {**(ing.get("unit_conversions") or {}), **y["conversions"]}}
    if y["unit"]:
        fields["default_unit"] = y["unit"]["word"]
        if y["unit"]["word"] == "block" or y["unit"]["word"] in set(stock.PACKS.values()):
            fields["pack"] = y["unit"]["word"]
    if where in ("fridge", "pantry"):
        fields["storage"] = where
    if not ing.get("keep_days"):
        fields["keep_days"] = PANTRY_KEEP_DAYS if where == "pantry" else FRIDGE_KEEP_DAYS
    if ing.get("freezes") is None:
        fields["freezes"] = True
    newest = latest(ing["id"])
    if not old or (newest and newest["id"] == old["id"]):         # an older pot's edit doesn't redefine the product
        ingredients.update(ing["id"], **fields)
    if ing.get("brand"):                     # a made thing isn't a store product
        _clear(ing["id"], "brand")
    entry = {"id": old["id"] if old else "mk_" + uuid.uuid4().hex[:8], "ingredient_id": ing["id"], "lines": lines,
             "input_g": round(input_g, 1), "yield_g": y["yield_g"], "yield_text": y["text"],
             "unit": y["unit"], "where": where, "date": date, "at": old["at"] if old else time.time()}
    if old and old.get("undone"):
        entry["undone"] = True
    data = store.load(_stock_file(), {"corrections": []})
    makes = data.setdefault("makes", [])
    if old:
        makes[:] = [entry if m["id"] == old["id"] else m for m in makes]
    else:
        makes.append(entry)
    store.save(_stock_file(), data)
    return entry


def _clear(ingredient_id: str, key: str) -> None:
    with ingredients.LOCK:
        data = ingredients._load()
        for i in data["ingredients"]:
            if i["id"] == ingredient_id:
                i.pop(key, None)
        ingredients._save(data)


def set_undone(make_id: str, undone: bool = True) -> None:
    data = store.load(_stock_file(), {"corrections": []})
    for m in data.get("makes", []):
        if m["id"] == make_id:
            m["undone"] = undone
            break
    else:
        raise KeyError(make_id)
    store.save(_stock_file(), data)


def in_week(week_start_iso: str) -> list[dict]:
    """The makes that count, dated in the 7 days from `week_start_iso`."""
    end = (datetime.date.fromisoformat(week_start_iso) + datetime.timedelta(days=7)).isoformat()
    return [m for m in _load() if not m.get("undone") and week_start_iso <= m["date"] < end]


def recent(limit: int = 12) -> list[dict]:
    return sorted(_load(), key=lambda m: (m["date"], m.get("at", 0)), reverse=True)[:limit]
