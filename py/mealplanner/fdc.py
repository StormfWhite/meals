"""USDA FoodData Central: ingredient search + nutrient lookup, cached.

Two SQLite tables, same shape as Print Finder's cache.py:
  fdc_search  query -> matches, 30-day TTL (ingredient search results don't
              meaningfully change week to week)
  fdc_foods   fdc_id -> normalized nutrients, NO TTL -- USDA's Foundation
              values for "raw eggplant" don't change, so once resolved an
              ingredient never needs a network call again.

Restricting search to Foundation + SR Legacy data types matters: without
it, "eggplant" returns dozens of branded frozen-eggplant-parm products
instead of one clean "Eggplant, raw" match.

Plain `requests`, not curl_cffi -- USDA's own API doesn't fingerprint the
TLS handshake the way marketplace sites do, so there's nothing to
impersonate.
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
from typing import Optional

import requests

from . import config
from .paths import FDC_CACHE_FILE, ensure_dirs

BASE = "https://api.nal.usda.gov/fdc/v1"
SEARCH_TTL = 30 * 24 * 3600  # 30 days

# USDA nutrient ids -> the flat keys used throughout this app (household
# targets, ingredient manual_nutrients, recipe rollups). Verified against a
# live response the first time this ran; a wrong id would silently return
# 0 rather than error, which is what test_fdc_cache.py's fixture guards
# against.
NUTRIENT_IDS = {
    1008: "calories_kcal",
    1003: "protein_g",
    1079: "fiber_g",
}
# bumped when what's read out of a USDA record changes: older cached records are read again
# (2: Atwater kcal for Foundation foods, survey foods' "1 cup" portions; 3: `missing`)
NORMALIZED_V = 3
VITAMIN_IDS = {
    1162: "vitamin_c_mg",
    1106: "vitamin_a_mcg",
    1089: "iron_mg",
    1087: "calcium_mg",
}


def available() -> bool:
    return config.fdc_key_set()


def _connect() -> sqlite3.Connection:
    ensure_dirs()
    conn = sqlite3.connect(str(FDC_CACHE_FILE))
    conn.execute("""CREATE TABLE IF NOT EXISTS fdc_search (
        query TEXT PRIMARY KEY, results TEXT NOT NULL, fetched_at REAL NOT NULL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS fdc_foods (
        fdc_id INTEGER PRIMARY KEY, data TEXT NOT NULL, fetched_at REAL NOT NULL)""")
    return conn


# On the phone, Python runs in the page and its HTTP is BLOCKING (pyodide_http = sync XHR): a
# "background" USDA lookup would still freeze the screen ~3 s per item. So a background resolve
# there runs with JS_RESPONSES switched on: an answer the page has already fetched is used, and a
# missing one raises NeedFetch(url) -- the page fetches it asynchronously, stores it here and runs
# the resolve again (bridge.js). BaseException on purpose: the broad `except Exception`s that make
# lookups best-effort must not swallow "go and fetch this".
JS_RESPONSES: Optional[dict] = None   # on only during such a resolve
JS_STORE: dict = {}                     # url -> (status, text), filled by the page


class NeedFetch(BaseException):
    def __init__(self, url: str):
        super().__init__(url)
        self.url = url


def _get(path: str, params: dict) -> Optional[dict]:
    key = config.get("usda_fdc_api_key")
    if not key:
        return None
    params = {**params, "api_key": key}
    if JS_RESPONSES is not None:
        url = requests.Request("GET", f"{BASE}{path}", params=params).prepare().url
        if url not in JS_RESPONSES:
            raise NeedFetch(url)
        status, text = JS_RESPONSES[url]
        if status >= 400:
            raise requests.HTTPError(f"{status} for {path}")
        return json.loads(text)
    resp = requests.get(f"{BASE}{path}", params=params, timeout=15)
    resp.raise_for_status()
    return resp.json()


# survey (FNDDS) foods joined the search -- answers cached before that are asked again
SEARCH_KEY = "|fndds"


def search(query: str) -> list[dict]:
    """Ingredient name -> [{fdc_id, description, data_type, food_category}],
    cache-first.

    `food_category` is USDA's own grouping ("Vegetables and Vegetable
    Products"), which is what lets a freshly typed ingredient be filed as a
    vegetable without anyone tagging it -- see aisles.py. A cache row
    written before that field existed is treated as stale rather than
    served back missing a key its callers now read."""
    query = query.strip().lower()
    if not query:
        return []
    conn = _connect()
    try:
        key = query + SEARCH_KEY
        row = conn.execute("SELECT results, fetched_at FROM fdc_search WHERE query = ?", (key,)).fetchone()
        if row and time.time() - row[1] < SEARCH_TTL:
            cached = json.loads(row[0])
            if all("food_category" in r for r in cached):
                return cached

        # USDA's front end turns some survey-food searches away (a bare 400) now and then:
        # again once, then without the survey foods
        data, partial = None, False
        for types in ("Foundation,SR Legacy,Survey (FNDDS)",) * 2 + ("Foundation,SR Legacy",):
            try:
                data = _get("/foods/search", {"query": query, "pageSize": 15, "dataType": types})
                partial = "FNDDS" not in types
                break
            except requests.HTTPError:
                continue
        if data is None:
            return []
        results = [
            {"fdc_id": f["fdcId"], "description": f["description"],
             "data_type": f.get("dataType", ""), "food_category": _category_name(f)}
            for f in data.get("foods", [])
        ]
        if not partial:                 # an answer without the survey foods is asked for again
            conn.execute("INSERT OR REPLACE INTO fdc_search (query, results, fetched_at) VALUES (?, ?, ?)",
                         (key, json.dumps(results), time.time()))
            conn.commit()
        return results
    finally:
        conn.close()


def _category_name(food: dict) -> str:
    """USDA reports the category as a bare string on search hits and as an
    object on a full food record."""
    cat = food.get("foodCategory")
    if isinstance(cat, dict):
        return cat.get("description", "") or ""
    # survey (FNDDS) foods file under WWEIA's categories instead ("Yogurt, Greek")
    wweia = food.get("wweiaFoodCategory")
    if not cat and isinstance(wweia, dict):
        return wweia.get("wweiaFoodCategoryDescription", "") or ""
    return cat or ""


# USDA's category names -> this app's six. Substring matched, longest
# rule first, because "Fruits and Fruit Juices" must not be caught by a
# "juice" rule and "Vegetables and Vegetable Products" reads as vegetable.
_CATEGORY_MAP = (
    ("vegetable", "vegetable"),
    ("fruit", "fruit"),
    ("legume", "protein"),
    ("nut and seed", "protein"),
    ("beef", "protein"),
    ("pork", "protein"),
    ("poultry", "protein"),
    ("lamb", "protein"),
    ("sausage", "protein"),
    ("finfish", "protein"),
    ("shellfish", "protein"),
    ("dairy and egg", "dairy"),
    ("yogurt", "dairy"),
    ("cheese", "dairy"),
    ("milk", "dairy"),
    ("cereal grain", "grain"),
    ("baked", "grain"),
    ("breakfast cereal", "grain"),
)


def category_for(food_category: str) -> str:
    """One of ingredients.CATEGORIES for a USDA category string."""
    lowered = (food_category or "").lower()
    for needle, category in _CATEGORY_MAP:
        if needle in lowered:
            return category
    return "other"


def _portions(food: dict) -> dict:
    """USDA's own portion table as {unit_name: grams}.

    This is what turns "1 clove" or "1/2 cup" into a real number of grams,
    which is the difference between an ingredient that can be counted
    towards a nutrition total and one that shows "unknown" forever. USDA
    gives the portion as a modifier ("cup, chopped") plus an amount, so a
    2-cup portion is divided back down to per-one-unit."""
    out: dict[str, float] = {}
    for p in food.get("foodPortions", []) or []:
        grams = p.get("gramWeight")
        amount = p.get("amount") or 1
        if not grams or not amount:
            continue
        unit = ((p.get("measureUnit") or {}).get("name") or "").strip().lower()
        if unit in ("", "undetermined"):
            # e.g. {"modifier": "cup, chopped"} with no measure unit
            unit = (p.get("modifier") or "").strip().lower()
            # survey foods: the modifier is a code, the words are "1 cup" / "1 fruit"
            m = re.match(r"^([\d.]+)\s+([a-z][a-z ]*)", (p.get("portionDescription") or "").lower())
            if (not unit or unit.isdigit()) and m:
                amount, unit = float(m.group(1)), m.group(2)
        unit = unit.split(",")[0].strip()
        if not unit or unit == "undetermined":
            continue
        per_one = grams / amount
        # first portion listed for a unit wins -- USDA orders them
        # sensibly and "cup, sliced" shouldn't overwrite plain "cup"
        out.setdefault(unit, round(per_one, 2))
    return out


def _normalize(food: dict) -> dict:
    out = {k: 0.0 for k in NUTRIENT_IDS.values()}
    out["vitamins"] = {}
    for n in food.get("foodNutrients", []):
        nid = (n.get("nutrient") or {}).get("id") or n.get("nutrientId")
        amount = n.get("amount", n.get("value"))
        if amount is None:
            continue
        if nid in NUTRIENT_IDS:
            out[NUTRIENT_IDS[nid]] = amount
        elif nid in VITAMIN_IDS:
            out["vitamins"][VITAMIN_IDS[nid]] = amount
    # newer Foundation records give energy only as Atwater kcal (2048 specific, 2047 general), no 1008
    if not out["calories_kcal"]:
        found = {}
        for n in food.get("foodNutrients", []):
            nid = (n.get("nutrient") or {}).get("id") or n.get("nutrientId")
            if nid in (2047, 2048) and n.get("amount", n.get("value")) is not None:
                found[nid] = n.get("amount", n.get("value"))
        out["calories_kcal"] = round(found.get(2048) or found.get(2047) or 0.0, 1)
    out["portions"] = _portions(food)
    # what the record doesn't list at all (not "0") -- filled from another record of the same food
    listed = {(n.get("nutrient") or {}).get("id") or n.get("nutrientId") for n in food.get("foodNutrients", [])}
    out["missing"] = [k for nid, k in NUTRIENT_IDS.items() if nid not in listed and not out[k]]
    out["v"] = NORMALIZED_V
    out["description"] = food.get("description", "")
    out["food_category"] = _category_name(food)
    return out


def get_nutrients(fdc_id: int) -> Optional[dict]:
    """Normalized per-100g nutrients for one FDC food, cache-first, no TTL.

    A row cached before portions existed is refetched rather than served:
    the nutrients in it are still right, but a caller asking for unit
    conversions would silently get none and every "1 cup" would stay
    unpriceable."""
    conn = _connect()
    try:
        row = conn.execute("SELECT data FROM fdc_foods WHERE fdc_id = ?", (fdc_id,)).fetchone()
        if row:
            cached = json.loads(row[0])
            # a survey food read before its "1 cup" portions were understood ({"10205": 180})
            if cached.get("v") == NORMALIZED_V:
                return cached

        food = _get(f"/food/{fdc_id}", {})
        if food is None:
            return None
        normalized = _normalize(food)
        conn.execute("INSERT OR REPLACE INTO fdc_foods (fdc_id, data, fetched_at) VALUES (?, ?, ?)",
                     (fdc_id, json.dumps(normalized), time.time()))
        conn.commit()
        return normalized
    finally:
        conn.close()


# ── picking a match automatically ────────────────────────────────────────
#
# USDA answers "chicken" with two hundred foods. Binding an ingredient to
# the wrong one is worse than binding it to nothing (a plausible but wrong
# calorie count is unfalsifiable at a glance), so the scoring below is
# deliberately conservative: it rewards a description that *is* the thing
# asked for, and refuses to guess when nothing scores well enough.

MIN_MATCH_SCORE = 0.45


def _match_score(query: str, result: dict) -> float:
    """How well one search hit answers `query`, 0..1."""
    desc = (result.get("description") or "").lower()
    q = query.strip().lower()
    if not desc or not q:
        return 0.0

    # USDA descriptions are "Head, raw" style: comma-separated qualifiers
    # after the food itself. The first segment is the food.
    segments = [s.strip() for s in desc.split(",") if s.strip()]
    head = segments[0] if segments else desc
    qualifiers = segments[1:]

    def stem(w: str) -> str:            # strawberries / strawberry, tomatoes / tomato, grapes / grape
        if w.endswith("ies") and len(w) > 4:
            return w[:-3] + "y"
        if w.endswith("oes") and len(w) > 4:
            return w[:-2]
        return w[:-1] if w.endswith("s") and not w.endswith("ss") and len(w) > 3 else w
    words = lambda t: {stem(w) for w in re.split(r"[^a-z]+", t) if w}
    if head == q:
        score = 1.0
    elif q in head.split():
        score = 0.8
    elif head.startswith(q) or q.startswith(head):
        score = 0.7
    elif q in desc:
        score = 0.5
    else:
        shared = set(q.split()) & set(re.split(r"[^a-z]+", desc))
        if not shared:
            return 0.0
        score = 0.3 * (len(shared) / max(len(q.split()), 1))
    # every word asked for is in it: "greek yogurt" is "Yogurt, Greek, plain"
    if len(q.split()) > 1 and words(q) <= words(desc):
        score = max(score, 0.62)

    # "raw" is the right default for an ingredient going into a recipe;
    # every extra qualifier is a more specific food than was asked for.
    if any(qual.startswith("raw") for qual in qualifiers):
        score += 0.12
    score -= 0.03 * len(qualifiers)
    if result.get("data_type") == "Foundation":
        score += 0.05
    return max(0.0, min(1.2, score))


def ranked_matches(name: str, limit: int = 4) -> list[dict]:
    """Every good-enough match for a name, best first."""
    if not available():
        return []
    try:
        results = search(name)
    except Exception:
        return []
    scored = [(_match_score(name, r), r) for r in results]
    scored = [(s, r) for s, r in scored if s >= MIN_MATCH_SCORE]
    scored.sort(key=lambda pair: -pair[0])
    return [{**r, "score": round(s, 3)} for s, r in scored[:limit]]


def best_match(name: str) -> Optional[dict]:
    """The USDA food an ingredient name most likely means, or None when
    nothing is a good enough answer to bind automatically."""
    matches = ranked_matches(name, limit=1)
    return matches[0] if matches else None
