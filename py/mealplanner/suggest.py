"""What ingredient you probably mean next.

The catalog sorted alphabetically is useless the moment it has fifty
entries in it: typing "c" offers cabbage before chicken forever. This
module ranks the same catalog by what's actually been cooked, reading
only what's already recorded -- board.json's slot history plus the recipes
those slots point at. Nothing new is stored, and nothing here needs the
user to log anything (unlike learning.py's purchase-outcome EMA).

Four signals, deliberately plain arithmetic in the house style:

  familiarity   how much it gets used at all, with older uses decaying
                (half-life HALF_LIFE_DAYS) so last spring's habits fade
  slot          how much of that use is at *this* meal -- oats read as a
                breakfast word, ground beef doesn't
  name          how close this meal's name is to the names of the meals
                it usually appears in, so typing "chicken curry" pulls up
                what went into "coconut chicken curry"
  partner       how often it shows up alongside the ingredients already
                written on this block

A candidate has to survive the typed text first (prefix beats word-start
beats substring); the signals then order what's left. With an empty box
the ranking still stands on its own, which is what makes tabbing down a
meal worth doing -- the first suggestion is usually the right one before
a key is pressed.

Reasons are reported, not just scores: the row says *why* it's up there
("goes with rice", "usual breakfast"), because a suggestion you can't
account for is one you have to double-check.
"""
from __future__ import annotations

import datetime
import difflib
import math
import re
import statistics
from typing import Iterable, Optional

from . import board, ingredients, recipes

HALF_LIFE_DAYS = 60.0
FADE_DAYS = 70             # not cooked in 10 weeks and not on a list: no longer offered unasked
# Relative pull of each signal. `name` leads on purpose: "what do I put in
# meals called roughly this" is the sharpest thing the history knows.
# `list` sits above it: an ingredient already on the week's shopping list
# is food that will physically be in the kitchen, which beats every guess
# drawn from history about what usually goes together.
WEIGHTS = {"familiarity": 1.0, "slot": 0.6, "name": 1.4, "partner": 1.0, "list": 1.6}
EXACT_MATCH_BONUS = 10.0   # > sum(WEIGHTS) + every other bonus, on purpose (see _match_bonus)
MIN_NAME_SIM = 0.34       # below this two meal names aren't "similar", they just share a letter
STOPWORDS = {"a", "an", "and", "the", "with", "of", "in", "on", "my", "our", "some", "for", "n"}


# ── text ──────────────────────────────────────────────────────────────
def _tokens(text: str) -> set[str]:
    words = re.split(r"[^a-z0-9]+", (text or "").lower())
    return {w for w in words if w and w not in STOPWORDS}


def name_similarity(a: str, b: str) -> float:
    """How alike two meal names are. Shared words dominate (Jaccard), with
    a character-level ratio underneath so "chicken curry"/"chicken korma"
    still reads as closer than "chicken curry"/"oatmeal"."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    jaccard = len(ta & tb) / len(ta | tb)
    chars = difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()
    return 0.72 * jaccard + 0.28 * chars


def _match_bonus(query: str, name: str) -> Optional[float]:
    """None means "this one doesn't match at all" -- an empty query matches
    everything, which is what makes the dropdown useful before typing."""
    q = (query or "").strip().lower()
    if not q:
        return 0.0
    n = name.lower()
    if n == q:
        # Deliberately larger than every other signal added together: the
        # frontend pre-highlights the first row and Tab takes it, so a name
        # typed out in full has to complete to itself and never to some
        # better-used ingredient that merely contains it ("rice" must not
        # turn into "brown rice" under your hands).
        return EXACT_MATCH_BONUS
    if n.startswith(q):
        return 0.35
    if any(word.startswith(q) for word in re.split(r"[^a-z0-9]+", n) if word):
        return 0.25
    if q in n:
        return 0.10
    return None


# ── history ───────────────────────────────────────────────────────────
def _recency(date_iso: str, today: datetime.date) -> float:
    try:
        age = (today - datetime.date.fromisoformat(date_iso)).days
    except ValueError:
        return 0.5
    if age < 0:                       # a meal planned for next week counts fully
        age = 0
    return 0.5 ** (age / HALF_LIFE_DAYS)


def _history(today: datetime.date) -> tuple[dict, dict]:
    """Every recorded use of every ingredient, plus the co-occurrence map.

    Uses come from the board (each slot's effective list -- its overrides
    if it has them, else the recipe's own, the same precedence nutrition
    and stats already use). Recipes that have never been scheduled still
    contribute one weak, dateless use so a saved-but-never-cooked recipe
    isn't invisible."""
    uses: dict[str, list[dict]] = {}
    partners: dict[str, dict[str, float]] = {}
    recipe_by_id = {r["id"]: r for r in recipes.list_recipes()}
    scheduled: set[str] = set()

    def record(ing_list: Iterable[dict], weight: float, meal: Optional[str], recipe_name: str) -> None:
        ids = []
        for item in ing_list or []:
            ing_id = item.get("ingredient_id")
            if not ing_id or ing_id in ids:
                continue
            ids.append(ing_id)
            uses.setdefault(ing_id, []).append({
                "weight": weight, "meal": meal, "recipe_name": recipe_name,
                "qty": item.get("qty"), "unit": item.get("unit"),
            })
        for ing_id in ids:
            row = partners.setdefault(ing_id, {})
            for other in ids:
                if other != ing_id:
                    row[other] = row.get(other, 0.0) + weight

    for slot in board.all_slots_history():
        recipe = recipe_by_id.get(slot["recipe_id"])
        if recipe is None:
            continue
        scheduled.add(recipe["id"])
        ing_list = slot.get("ingredient_overrides") or recipe["ingredients"]
        record(ing_list, _recency(slot["date"], today), slot["meal"], recipe["name"])

    for recipe in recipe_by_id.values():
        if recipe["id"] not in scheduled:
            record(recipe["ingredients"], 0.25, None, recipe["name"])

    return uses, partners


def _typical_amount(rows: list[dict]) -> Optional[dict]:
    """The amount usually written for this ingredient: the median quantity
    in whichever unit it's most often measured in. Shown as a hint beside
    the suggestion and as the amount box's placeholder -- never filled in
    as a value, because a quantity nobody typed must not reach the plan."""
    by_unit: dict[str, list[float]] = {}
    for row in rows:
        qty, unit = row.get("qty"), (row.get("unit") or "").strip()
        if not qty:
            continue
        by_unit.setdefault(unit, []).append(float(qty))
    if not by_unit:
        return None
    unit = max(by_unit, key=lambda u: len(by_unit[u]))
    qty = statistics.median(by_unit[unit])
    qty = round(qty * 100) / 100
    return {"qty": qty, "unit": unit, "label": f"{qty:g} {unit}".strip()}


# ── ranking ───────────────────────────────────────────────────────────
def _on_the_lists(week_start: Optional[str]) -> dict[str, str]:
    """ingredient_id -> which list it's on for this week.

    The two shopping lists are the pool a meal is built from: what's
    already being bought is what there'll actually be to cook with. It's
    read here rather than assumed, so an item added by hand to the market
    list (never used in any recipe) is offered just as readily as one the
    history knows well."""
    if not week_start:
        return {}
    try:
        from . import groceries  # local: groceries imports plenty, suggest is imported early
        return {item["ingredient_id"]: item["shop_list"]
                for item in groceries.get_week_groceries(week_start, with_prices=False)}
    except Exception:
        return {}


def ingredients_for(q: str = "", meal: Optional[str] = None, meal_name: str = "",
                    with_ids: Iterable[str] = (), exclude_ids: Iterable[str] = (),
                    limit: int = 8, today: Optional[datetime.date] = None,
                    week: Optional[str] = None) -> list[dict]:
    today = today or datetime.date.today()
    catalog = ingredients.list_ingredients()
    uses, partners = _history(today)
    on_list = _on_the_lists(week)
    with_ids = [i for i in with_ids if i]
    skip = set(exclude_ids) | set(with_ids)

    totals = {ing_id: sum(u["weight"] for u in rows) for ing_id, rows in uses.items()}
    busiest = max(totals.values(), default=0.0) or 1.0
    partner_totals = {i: sum(row.values()) for i, row in partners.items()}

    # when each was last cooked (a saved recipe never planned counts as not cooked)
    last: dict[str, str] = {}
    recipe_by_id = {r["id"]: r for r in recipes.list_recipes()}
    for slot in board.all_slots_history():
        recipe = recipe_by_id.get(slot["recipe_id"])
        for item in (slot.get("ingredient_overrides") or (recipe or {}).get("ingredients") or []):
            i = item.get("ingredient_id")
            if i and slot["date"] > last.get(i, ""):
                last[i] = slot["date"]
    fade_before = (today - datetime.timedelta(days=FADE_DAYS)).isoformat()

    scored = []
    for ing in catalog:
        if ing["id"] in skip:
            continue
        bonus = _match_bonus(q, ing["name"])
        if bonus is None:
            continue
        typed_it = q.strip().lower() == ing["name"].strip().lower()
        # × on it (until it's cooked again), or gone quiet: only when typed out in full
        hidden = ing.get("hide_suggest") and last.get(ing["id"], "") <= ing["hide_suggest"]
        # last cooked long ago -- or never, and made long ago (no date: an old one, kept)
        seen = last.get(ing["id"]) or ing.get("created", "9999")
        quiet = seen < fade_before and ing["id"] not in on_list
        if (hidden or quiet) and not typed_it:
            continue
        rows = uses.get(ing["id"], [])
        # Square root, not the raw share: something eaten three mornings a
        # week otherwise swamps every other signal, and a staple you cook
        # 18 times isn't three times the suggestion a thing you cook 6
        # times is. Order among equally-relevant ingredients is unchanged
        # (sqrt is monotonic) -- it just stops the busiest line in the
        # history from winning every box you type into.
        parts = {"familiarity": math.sqrt(min(1.0, totals.get(ing["id"], 0.0) / busiest))}

        if meal and rows:
            same = sum(u["weight"] for u in rows if u["meal"] == meal)
            parts["slot"] = same / totals[ing["id"]]

        best_name, best_sim = None, 0.0
        for u in rows:
            sim = name_similarity(meal_name, u["recipe_name"])
            if sim > best_sim:
                best_name, best_sim = u["recipe_name"], sim
        if best_sim >= MIN_NAME_SIM:
            parts["name"] = best_sim

        best_partner, best_partner_score = None, 0.0
        row = partners.get(ing["id"], {})
        for other in with_ids:
            shared = row.get(other, 0.0)
            if not shared:
                continue
            score = shared / max(totals.get(ing["id"], shared), shared)
            if score > best_partner_score:
                best_partner, best_partner_score = other, score
        if best_partner:
            parts["partner"] = best_partner_score

        listed = on_list.get(ing["id"])
        if listed:
            parts["list"] = 1.0

        score = bonus + sum(WEIGHTS[k] * v for k, v in parts.items())
        scored.append({
            "id": ing["id"], "name": ing["name"], "category": ing.get("category", "other"),
            "default_unit": ing.get("default_unit", "g"),
            "shop_list": ing.get("shop_list"),
            "on_list": listed,
            "score": round(score, 4),
            "typical": _typical_amount(rows),
            "reason": _reason(parts, rows, best_name, best_partner, meal, listed),
        })

    scored.sort(key=lambda s: (-s["score"], s["name"].lower()))
    # one per name, and never a name the meal already has (two copies of an ingredient)
    seen = {i["name"].strip().lower() for i in catalog if i["id"] in skip}
    scored = [s for s in scored if not (s["name"].strip().lower() in seen or seen.add(s["name"].strip().lower()))]
    return scored[:limit]


def _reason(parts: dict, rows: list[dict], best_name: Optional[str],
            best_partner: Optional[str], meal: Optional[str],
            listed: Optional[str] = None) -> str:
    """One short phrase for the strongest reason this row is here. Ordered
    by how specific the signal is, not by how big the number came out --
    "goes with rice" tells you more than "used often" even when
    familiarity scored higher."""
    if not rows:
        # An item on the list with no history at all still has something
        # worth saying, and it's the most concrete reason there is.
        return "on the market list" if listed == "market" else ("on the list" if listed else "")
    weighted = {k: WEIGHTS[k] * v for k, v in parts.items()}
    if best_partner and weighted.get("partner", 0) >= 0.35:
        partner = ingredients.get(best_partner)
        if partner:
            return f"goes with {partner['name'].lower()}"
    if best_name and weighted.get("name", 0) >= 0.5:
        return f"in {best_name.lower()}"
    if meal and parts.get("slot", 0) >= 0.7 and len(rows) >= 3:
        return f"usual {meal}"
    if len(rows) >= 3:
        return f"used {len(rows)}×"
    return ""
