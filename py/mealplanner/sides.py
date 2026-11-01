"""A side for dinner: what the day is missing, and what we usually eat with this main.

Storm 2026-11-01: "with dinner it offers a side with stuff that we are missing like protein or
whatever and it learns what we often link together to pair mains with sides ... from what we did
last".

All counting, no model: the pairs are READ off the plan history (a dinner's first block is the
main, every later block of that dinner a side -- the same "Also" blocks Storm already makes), so
there is nothing to log and accepting a suggestion teaches it by becoming one more slot. A side is
ranked by (1) how much of the day's low nutrients its pot closes (the same `short`/`scale` footing
gaps._rank uses), (2) how often it went with this main, or with a main that has a similar name
("lentil soup" ~ "tomato soup"), and (3) a little for sides we simply eat a lot. Sides come from
meals already eaten as a side; whole foods (gaps.py) fill in while the history is thin. A dismissed
pairing is left out for DISMISS_DAYS. Nothing is added by itself; the + tap does it.
"""
from __future__ import annotations

import datetime
from typing import Optional

from . import board, household, ingredients, nutrition, recipes, store, suggest
from .paths import DATA_DIR

DISMISS_FILE = DATA_DIR / "side_dismissed.json"
HALF_LIFE_DAYS = 90.0     # a pairing from last season counts for half
SIMILAR_MIN = 0.5         # name similarity at which another main's sides inform this one
SIMILAR_W = 0.5           # ...and how much (times the similarity)
PAIR_W = 0.6              # affinity (0..1) against fill (a few tenths per nutrient closed)
POP_W = 0.15              # a side eaten often at all
RECENT_DAYS = 2           # eaten this recently as a side: held back
RECENT_KEEP = 0.6
DISMISS_DAYS = 21
MAX_SIDES = 3
MIN_HELP = 0.08           # closes at least 8% of a nutrient's daily amount to be named
NAME_N = 3                # nutrients named on one suggestion (the biggest closers)
SIDE_G = 200.0            # a whole food as a side: at most this much per person


def _age_weight(date_iso: str, today: datetime.date) -> float:
    try:
        age = max(0, (today - datetime.date.fromisoformat(date_iso)).days)
    except ValueError:
        age = 0
    return 0.5 ** (age / HALF_LIFE_DAYS)


class Model:
    """The pairings, read once per request off every dinner ever planned."""

    def __init__(self, today: Optional[datetime.date] = None):
        self.today = today or datetime.date.today()
        self.pairs: dict[str, dict[str, float]] = {}   # main recipe -> side recipe -> weighted times
        self.counts: dict[str, dict[str, int]] = {}    # the same, plain counts (for the words)
        self.side_pop: dict[str, float] = {}           # side recipe -> weighted times eaten as a side
        self.side_last: dict[str, str] = {}            # side recipe -> latest date eaten as a side
        self.names = {r["id"]: r["name"] for r in recipes.list_recipes()}
        by_day: dict[str, list[dict]] = {}
        for s in board.all_slots_history():
            if s["meal"] == "dinner" and s.get("recipe_id") in self.names:
                by_day.setdefault(s["date"], []).append(s)
        for date, slots in by_day.items():
            slots.sort(key=lambda s: s["index"])
            main, rest = slots[0], slots[1:]
            w = _age_weight(date, self.today)
            for s in rest:
                m, sd = main["recipe_id"], s["recipe_id"]
                if sd == m:
                    continue
                self.pairs.setdefault(m, {})[sd] = self.pairs.get(m, {}).get(sd, 0.0) + w
                self.counts.setdefault(m, {})[sd] = self.counts.get(m, {}).get(sd, 0) + 1
                self.side_pop[sd] = self.side_pop.get(sd, 0.0) + w
                if date > self.side_last.get(sd, ""):
                    self.side_last[sd] = date

    def known_sides(self) -> list[str]:
        return list(self.side_pop)

    def affinity(self, main_id: str, side_id: str) -> tuple[float, int, Optional[str]]:
        """(strength, times it went with this very main, the similar main it was learned from).
        Strength is saturating, so one pairing counts ~0.5 and a habit approaches 1."""
        direct = self.pairs.get(main_id, {}).get(side_id, 0.0)
        near, near_main = 0.0, None
        me = self.names.get(main_id, "")
        for other, sides in self.pairs.items():
            if other == main_id or side_id not in sides:
                continue
            sim = suggest.name_similarity(me, self.names.get(other, ""))
            if sim >= SIMILAR_MIN and sim * sides[side_id] > near:
                near, near_main = sim * sides[side_id], other
        raw = direct + SIMILAR_W * near
        return raw / (raw + 1.0), self.counts.get(main_id, {}).get(side_id, 0), near_main if not direct else None


# ── dismissals ────────────────────────────────────────────────────────────
def _dismissed() -> dict:
    return store.load(DISMISS_FILE, {})


def dismiss(main_id: str, side_key: str, today: Optional[datetime.date] = None) -> None:
    data = _dismissed()
    data[f"{main_id}|{side_key}"] = (today or datetime.date.today()).isoformat()
    store.save(DISMISS_FILE, data)


def undismiss(main_id: str, side_key: str) -> None:
    data = _dismissed()
    if data.pop(f"{main_id}|{side_key}", None) is not None:
        store.save(DISMISS_FILE, data)


def _is_dismissed(data: dict, main_id: str, side_key: str, today: datetime.date) -> bool:
    d = data.get(f"{main_id}|{side_key}")
    if not d:
        return False
    try:
        return (today - datetime.date.fromisoformat(d)).days < DISMISS_DAYS
    except ValueError:
        return False


# ── the day's main ────────────────────────────────────────────────────────
def main_of(date_iso: str) -> Optional[dict]:
    """The dinner's recipe when it's a lone main (no side planned yet), else None."""
    blocks = board.day_slots(date_iso)["slots"].get("dinner") or []
    live = [b for b in blocks if b.get("recipe_id")]
    if len(live) != 1:
        return None
    r = recipes.get(live[0]["recipe_id"])
    return {"recipe_id": r["id"], "name": r["name"]} if r else None


# ── ranking ───────────────────────────────────────────────────────────────
def _gain(totals: dict, key: str) -> float:
    if key in ("calories_kcal", "protein_g", "fiber_g"):
        return float(totals.get(key) or 0.0)
    return float((totals.get("vitamins") or {}).get(key) or 0.0)


def _fill(totals: dict, low: list[dict]) -> tuple[float, list[dict]]:
    """How much of the day's gaps one pot of this closes (the footing gaps._rank scores on),
    and the nutrients it moves enough to be worth naming."""
    score, helps = 0.0, []
    for l in low:
        g = _gain(totals, l["key"])
        score += min(g, l["short"]) / l["scale"]
        if g / l["scale"] >= MIN_HELP:
            helps.append((g / l["scale"], {"key": l["key"], "label": l["label"], "unit": l["unit"],
                                           "amount": round(g, 1) if g < 10 else round(g)}))
    helps.sort(key=lambda h: -h[0])
    # the average gap closed, so a day low in 13 things doesn't drown the learned pairs
    return score / max(1, len(low)), [h for _, h in helps[:NAME_N]]


def _recipe_rows(r: dict) -> list[dict]:
    return r.get("last_ingredients") or r.get("ingredients") or []


def for_day(date_iso: str, low: list[dict], model: Model, food_cands: Optional[list[dict]] = None,
            day_ingredient_ids: Optional[set] = None, dismissed: Optional[dict] = None) -> list[dict]:
    """Up to MAX_SIDES sides for this date's dinner, best first; [] when it already has a side
    (the day's numbers include it) or no main.

    `low` = gaps.lows rows (with `short`/`scale`); `food_cands` = ranked-able whole foods
    [{name, fdc_id, per100, grams, portion, kind: "have"|"buy"}] standing in while history is thin."""
    main = main_of(date_iso)
    if main is None:
        return []
    today = model.today
    dismissed = _dismissed() if dismissed is None else dismissed
    by_id = ingredients.by_id()
    in_day = day_ingredient_ids or set()
    out = []
    # a food that is already in the main, or is the heart of a recipe side offered below, adds nothing
    taken = {x["ingredient_id"] for x in _recipe_rows(recipes.get(main["recipe_id"]) or {})}
    for sid in model.known_sides():
        r = recipes.get(sid)
        if r is None or sid == main["recipe_id"] or r.get("hide_suggest"):
            continue
        rows = _recipe_rows(r)
        if not rows or _is_dismissed(dismissed, main["recipe_id"], "r:" + sid, today):
            continue
        if in_day and {x["ingredient_id"] for x in rows} <= in_day:
            continue
        totals = nutrition.preview_totals(rows, by_id)["total"]
        fill, helps = _fill(totals, low)
        taken |= {x["ingredient_id"] for x in rows}
        aff, n, near = model.affinity(main["recipe_id"], sid)
        if not helps and aff <= 0:
            continue
        pop = model.side_pop.get(sid, 0.0)
        score = fill + PAIR_W * aff + POP_W * (pop / (pop + 1.0))
        last = model.side_last.get(sid)
        if last and (today - datetime.date.fromisoformat(last)).days <= RECENT_DAYS:
            score *= RECENT_KEEP
        if n:
            why = {"kind": "pair", "n": n, "main": main["name"]}
        elif near:
            why = {"kind": "like", "main": model.names.get(near, "")}
        elif helps:
            why = {"kind": "fills"}
        else:
            why = {"kind": "usual"}
        out.append({"kind": "recipe", "recipe_id": sid, "name": r["name"], "helps": helps, "why": why,
                    "learned": bool(n or near), "kcal": round(_gain(totals, "calories_kcal")),
                    "score": round(score, 3)})
    eaters = household.default_servings()
    for c in food_cands or []:
        if c.get("ingredient_id") in taken:
            continue
        if _is_dismissed(dismissed, main["recipe_id"], "f:" + c["name"].lower(), today):
            continue
        # a side's worth, not the 4 lb of squash it is usually bought by: one serving each
        grams = round(min(c["grams"], SIDE_G) * eaters)
        c = {**c, "grams": grams, "portion": _portion_text(grams)}
        totals = {k: v * grams / 100.0 for k, v in _flat(c["per100"]).items()}
        totals["vitamins"] = {k: v * grams / 100.0 for k, v in (c["per100"].get("vitamins") or {}).items()}
        fill, helps = _fill(totals, low)
        if not helps:
            continue
        out.append({"kind": "food", "name": c["name"], "grams": c["grams"], "portion": c["portion"],
                    "buy": c.get("kind") == "buy", "in_stock": bool(c.get("in_stock")),
                    "helps": helps, "why": {"kind": "fills"}, "learned": False,
                    "kcal": round(_gain(totals, "calories_kcal")), "score": round(fill * 0.9, 3)})
    out.sort(key=lambda s: -s["score"])
    return out[:MAX_SIDES]


def _portion_text(grams: float) -> str:
    return f"{round(grams / 28.35)} oz" if grams >= 57 else f"{round(grams)} g"


def _flat(per100: dict) -> dict:
    return {k: float(per100.get(k) or 0.0) for k in ("calories_kcal", "protein_g", "fiber_g")}


# ── accepting one ─────────────────────────────────────────────────────────
def accept(date_iso: str, recipe_id: Optional[str] = None, name: Optional[str] = None,
           grams: Optional[float] = None) -> dict:
    """The + tap: the side becomes the dinner's next block. A recipe goes in as it was last made;
    a whole food becomes a one-line recipe of its usual portion (found again by name next time).
    Returns the stored week."""
    from . import gaps
    if recipe_id:
        r = recipes.get(recipe_id)
        if r is None:
            raise KeyError(recipe_id)
    else:
        if not name or not grams or not (0 < grams <= 1500):
            raise ValueError("a food and an amount")
        r = next((x for x in recipes.list_recipes() if x["name"].strip().lower() == name.strip().lower()), None)
        if r is None:
            ing = gaps.ensure_ingredient(name)
            r = recipes.add(ing["name"], 1, [{"ingredient_id": ing["id"], "qty": round(float(grams)), "unit": "g",
                                              "note": ""}])
    week = board.week_of(date_iso)
    key = board.slot_key(date_iso, "dinner", board.next_slot_index(week, date_iso, "dinner"))
    return board.set_slot(week, key, r["id"], household.default_servings(), None)
