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
  "8 cups" / "4 qt" / "2 l"    a volume: the pot weighs what went in, a cup is 1/8 of it
  "12 servings" / "6 jars"     a count: the same, one of them is 1/12 of the pot
  blank                        the weight of what went in
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


def parse_yield(text: str, input_g: float) -> dict:
    """What the pot makes -> {yield_g, unit: {word, g, n} | None, text, conversions}. Nothing is
    saved here (the preview asks too); `conversions` are the units a meal line can then use.
    Several parts say several things (Storm 2026-10-25: "1 cup ... the right proportions"): in
    "8 cups, 3 lb" the weight is the pot's real weight and a cup is an eighth of it."""
    t = re.sub(r"\s+", " ", (text or "").strip().lower())
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
    k = 100.0 / made["yield_g"]
    tot = res["total"]
    out = {key: tot.get(key, 0.0) * k for key in nutrition.NUTRIENT_KEYS}
    out["vitamins"] = {key: v * k for key, v in (tot.get("vitamins") or {}).items()}
    out["unknown"] = res["unknown_ingredients"]
    return out


def make(name: str, lines: list[dict], yield_text: str, where: str, date: str) -> dict:
    """Make it: the product (an ingredient, made if new) gets the units the yield names, the
    make is recorded, and the replay does the rest."""
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
    y = parse_yield(yield_text, input_g)
    if not y["yield_g"]:
        raise ValueError('how much does it make? ("8 cups", "3 lb") -- the lines have no weight to go by')
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
    ingredients.update(ing["id"], **fields)
    if ing.get("brand"):                     # a made thing isn't a store product
        _clear(ing["id"], "brand")
    entry = {"id": "mk_" + uuid.uuid4().hex[:8], "ingredient_id": ing["id"], "lines": lines,
             "input_g": round(input_g, 1), "yield_g": y["yield_g"], "yield_text": y["text"],
             "unit": y["unit"], "where": where, "date": date, "at": time.time()}
    data = store.load(_stock_file(), {"corrections": []})
    data.setdefault("makes", []).append(entry)
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
