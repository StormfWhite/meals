"""What the list costs.

Two sources, in this order:

  kroger      live per-item prices from the Kroger Products API, for the
              store actually picked -- Kroger's public API covers every
              banner the company owns (Harris Teeter included), and needs a
              free self-serve client id/secret plus a store to price
              against. A live price is written into the remembered table
              too, so the list still totals when the network is gone.
  remembered  what this item cost last time, typed once. Never expires,
              never lies about being live: every price carries the date it
              was recorded, and the UI says how old it is.

Prices are remembered **per store**, because the same milk is not the same
price at two shops, and a total assembled from a mix of stores would be a
number that's true nowhere.

Deliberately not attempted: scraping a storefront. Price Hunt already
learned what that costs to maintain, and a wrong price on a grocery list
is worse than no price -- so an item with no price shows blank and the
total says how many items it's missing rather than quietly undercounting.
"""
from __future__ import annotations

import base64
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

from . import config, store
from .paths import PRICES_FILE

KROGER_BASE = "https://api.kroger.com/v1"
TOKEN_TTL_SLACK = 60          # refresh a little before it actually expires
LIVE_TTL = 3 * 24 * 3600      # a live price is worth re-fetching after a few days

_token: dict = {"value": None, "expires_at": 0.0}


# ── the remembered table ─────────────────────────────────────────────────

def _load() -> dict:
    return store.load(PRICES_FILE, {"prices": {}})


def _save(data: dict) -> None:
    store.save(PRICES_FILE, data)


def _store_key(shop: Optional[dict]) -> str:
    """One shop, stably identified. Falls back to a bare label so prices
    typed before a store was ever picked aren't stranded."""
    if not shop:
        return "unset"
    return shop.get("id") or shop.get("name") or "unset"


def remember(ingredient_id: str, shop: Optional[dict], price: float,
             package_g: Optional[float] = None, label: str = "",
             source: str = "typed", aisle: Optional[dict] = None,
             options: Optional[list] = None, nutrition: Optional[dict] = None,
             with_nutrition: bool = False, stock: Optional[str] = None,
             url: Optional[str] = None) -> dict:
    data = _load()
    per_store = data["prices"].setdefault(_store_key(shop), {})
    entry = {
        "price": round(float(price), 2),
        "package_g": package_g,
        "label": label,
        "source": source,
        "updated_at": time.time(),
        **(aisle or {}),
    }
    if options is not None:
        entry["options"] = options
    if stock:
        entry["stock"] = stock           # Kroger's stockLevel at that store: HIGH / LOW / TEMPORARILY_OUT_OF_STOCK
    if url:
        entry["url"] = url
    if with_nutrition:
        entry["nutrition"] = nutrition      # None too: "Kroger has no label for it", not asked again
    per_store[ingredient_id] = entry
    _save(data)
    return entry


def forget(ingredient_id: str, shop: Optional[dict]) -> None:
    data = _load()
    data["prices"].get(_store_key(shop), {}).pop(ingredient_id, None)
    _save(data)


def remembered(ingredient_id: str, shop: Optional[dict]) -> Optional[dict]:
    return _load()["prices"].get(_store_key(shop), {}).get(ingredient_id)


# ── Kroger ───────────────────────────────────────────────────────────────

def kroger_problem() -> str:
    """Why live prices aren't coming, in words, or "" -- shown in Settings."""
    if not kroger_configured():
        return ""
    _kroger_token()
    return _token.get("error", "")


def kroger_configured() -> bool:
    cfg = config.load()
    return bool(cfg.get("kroger_client_id") and cfg.get("kroger_client_secret"))


def _kroger_token() -> Optional[str]:
    if _token["value"] and time.time() < _token["expires_at"] - TOKEN_TTL_SLACK:
        return _token["value"]
    cfg = config.load()
    client_id, secret = cfg.get("kroger_client_id"), cfg.get("kroger_client_secret")
    if not client_id or not secret:
        return None
    basic = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials", "scope": "product.compact"}).encode()
    req = urllib.request.Request(
        f"{KROGER_BASE}/connect/oauth2/token", data=body,
        headers={"Authorization": f"Basic {basic}",
                 "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # invalid_scope = the app on developer.kroger.com wasn't given the Products API (2026-10-18:
        # Storm's keys worked for Locations only) -- say so, rather than prices silently not coming
        _token["error"] = ("Your Kroger app needs the Products API: on developer.kroger.com open the app, "
                           "add Products, save") if b"invalid_scope" in e.read() else f"Kroger said {e.code}"
        return None
    except Exception:
        return None
    _token.pop("error", None)
    _token["value"] = payload.get("access_token")
    _token["expires_at"] = time.time() + float(payload.get("expires_in", 1800))
    return _token["value"]


def _kroger_get(path: str, params: dict) -> Optional[dict]:
    token = _kroger_token()
    if not token:
        return None
    url = f"{KROGER_BASE}{path}?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}",
                                               "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def kroger_location_id(shop: dict) -> Optional[str]:
    """Kroger's own id for a store OpenStreetMap told us about, matched on
    postcode and then on how close the coordinates actually are -- a
    zipcode can hold two stores of the same banner."""
    if shop.get("kroger_location_id"):
        return shop["kroger_location_id"]
    zipcode = shop.get("postcode", "")[:5]
    if not zipcode:
        return None
    data = _kroger_get("/locations", {"filter.zipCode.near": zipcode, "filter.limit": 20})
    if not data:
        return None
    from .places import _haversine_km  # same-package helper, no new dependency

    best, best_km = None, 999.0
    for loc in data.get("data", []):
        coords = loc.get("geolocation") or {}
        lat, lon = coords.get("latitude"), coords.get("longitude")
        if lat is None or shop.get("lat") is None:
            continue
        km = _haversine_km(shop["lat"], shop["lon"], lat, lon)
        if km < best_km:
            best, best_km = loc, km
    if best is None or best_km > 3.0:
        return None
    return best.get("locationId")


def _parse_grams(size: str) -> Optional[float]:
    """"16 oz" / "1 lb" / "500 g" -> grams. Anything counted rather than
    weighed ("6 ct") returns None: a per-gram cost for six eggs is a number
    that would only mislead."""
    text = (size or "").strip().lower()
    if not text:
        return None
    m = re.match(r"^([\d.]+)\s*(oz|ounce|ounces|lb|lbs|lbr|pound|pounds|g|gram|grams|kg)\b", text)
    if not m:
        return None
    qty = float(m.group(1))
    unit = m.group(2)
    if unit.startswith("oz") or unit.startswith("ounce"):
        return qty * 28.3495
    if unit.startswith("lb") or unit.startswith("pound"):
        return qty * 453.592
    if unit == "kg":
        return qty * 1000
    return qty


# The Nutrition Facts panel Kroger sends with a product (2026-10-23: "yes use that"). Codes are
# GS1's; the units come with each value and are sometimes wrong (tofu's iron "in grams"), so every
# value is converted by its own unit and one in a unit we don't know is left out.
LABEL_CODES = {"ENER-": "calories_kcal", "PRO-": "protein_g", "PROTPL": "protein_g", "FIBTSW": "fiber_g",
               "FIBTG": "fiber_g", "K": "potassium_mg", "MG": "magnesium_mg", "CA": "calcium_mg",
               "FE": "iron_mg", "ZN": "zinc_mg", "VITC": "vitamin_c_mg", "VITA": "vitamin_a_mcg",
               "VITD": "vitamin_d_mcg", "VITB12": "b12_mcg", "FOLDFE": "folate_mcg", "FOL": "folate_mcg"}
LABEL_UNIT_G = {"GRM": 1.0, "MGM": 1e-3, "MC": 1e-6, "MCG": 1e-6}
OURS_PER_G = {"_g": 1.0, "_mg": 1e3, "_mcg": 1e6}
SERVING_G = {"GRM": 1.0, "MLT": 1.0, "OZA": 29.5735, "FO": 29.5735, "ONZ": 28.3495}   # a drink is ~1 g per ml
SERVING_UNITS = {"G21": "cup", "G24": "tbsp", "G25": "tsp", "EA": "each"}


def _kroger_label(product: dict, package_g: Optional[float]) -> Optional[dict]:
    """The product's label as {brand, description, upc, categories, serving: {qty, unit, g}, per_serving}.
    `g` is None when the serving is only in cups/each and the package doesn't say how many --
    brands.py then weighs it with the ingredient's own cup. None = no usable label."""
    best = None
    for panel in product.get("nutritionInformation") or []:
        vals: dict = {}
        for n in panel.get("nutrients") or []:
            ours, qty = LABEL_CODES.get(n.get("code")), n.get("quantity")
            unit = (n.get("unitOfMeasure") or {}).get("code")
            if ours is None or qty is None or ours in vals:
                continue
            if ours == "calories_kcal":
                vals[ours] = float(qty) / 4.184 if unit == "KJO" else float(qty)
            elif unit in LABEL_UNIT_G:
                suffix = ours[ours.rfind("_"):]
                vals[ours] = float(qty) * LABEL_UNIT_G[unit] * OURS_PER_G[suffix]
        if "calories_kcal" in vals and (best is None or len(vals) > len(best[0])):
            best = (vals, panel)
    if best is None:
        return None
    vals, panel = best
    size = panel.get("servingSize") or {}
    qty, unit = size.get("quantity"), (size.get("unitOfMeasure") or {}).get("code")
    if not qty:
        return None
    grams = qty * SERVING_G[unit] if unit in SERVING_G else None
    per_pack = (panel.get("servingsPerPackage") or {}).get("value")
    if grams is None and package_g and per_pack:
        grams = package_g / float(per_pack)
    return {"brand": product.get("brand") or "", "description": product.get("description") or "",
            "upc": product.get("upc") or product.get("productId"),
            "categories": product.get("categories") or [],
            "serving": {"qty": float(qty), "unit": SERVING_UNITS.get(unit, unit), "g": grams},
            "per_serving": vals}


# Not food -- a search for "hemp seeds" ranked an Epsom-salt soak (Personal Care) next to Hemp
# Hearts, "cashew butter" found a baby-food pouch (2026-10-18).
NON_FOOD = {"personal care", "health & beauty", "beauty", "baby", "pet care", "pet", "cleaning products",
            "household", "paper & plastic products", "home & garden", "kitchen", "health", "pharmacy"}


def _product_url(product: dict) -> Optional[str]:
    uri = product.get("productPageURI") or ""
    return "https://www.kroger.com" + uri.split("?")[0] if uri.startswith("/") else None


def _stem(word: str) -> str:
    word = word.lower().strip(".,®™'’")
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


_COLD = re.compile(r"\b(dairy|refrigerat|chilled|cooler|deli|meat|seafood|poultry|eggs?|yogurt|cheese|fresh pasta|tofu)\b", re.I)
_SHELF = re.compile(r"\b(aisle|pantry|canned|baking|cereal|snack|pasta|rice|beans|condiment|spice|oil|sauce|breakfast|beverage|coffee|tea|bakery|bread)\b", re.I)


def keep_where(product: dict) -> Optional[str]:
    """Where the store keeps it, so a bought one goes to the same place at home: "freezer" / "fridge" /
    "pantry" (the shelf), or None when it can't say (fresh produce varies: onions and potatoes sit out,
    lettuce doesn't). Kroger's own temperature flag first, then the aisle / department and categories."""
    ind = ((product.get("temperature") or {}).get("indicator") or "").strip().lower()
    if ind in ("frozen", "refrigerated", "ambient"):
        return {"frozen": "freezer", "refrigerated": "fridge", "ambient": "pantry"}[ind]
    text = " ".join([(a.get("description") or "") for a in (product.get("aisleLocations") or [])[:2]]
                    + [c for c in (product.get("categories") or [])])
    if re.search(r"\bfrozen\b", text, re.I):
        return "freezer"
    if _COLD.search(text):
        return "fridge"
    if _SHELF.search(text):
        return "pantry"
    return None


def _aisle(locations: list[dict]) -> dict:
    """Where the store shelves it, for walking the list in order: Kroger's first location gives
    "AISLE 1" (number 1, bay 12) or a department like "FRUIT" (number 0)."""
    if not locations:
        return {"aisle": "", "aisle_num": None, "aisle_bay": None}
    a = locations[0]
    num = lambda k: int(a[k]) if str(a.get(k, "")).isdigit() else None
    return {"aisle": (a.get("description") or "").strip().title(), "aisle_num": num("number"),
            "aisle_bay": num("bayNumber")}


def kroger_price(name: str, location_id: str) -> Optional[dict]:
    """The product an ingredient name means at one store: food only, every word of the name in
    the product's name when any result has that, then KROGER'S OWN ranking -- not the cheapest
    hit, which is how an Epsom soak once priced "hemp seeds"."""
    data = _kroger_get("/products", {
        "filter.term": name, "filter.locationId": location_id, "filter.limit": 20,
    })
    if not data:
        return None
    want = {_stem(w) for w in name.split() if len(w) > 1}
    ranked = []
    for rank, product in enumerate(data.get("data", [])):
        cats = {c.lower() for c in product.get("categories") or []}
        if cats and cats <= NON_FOOD | {"natural & organic"}:
            continue
        items = product.get("items") or []
        if not items:
            continue
        item = items[0]
        price_block = item.get("price") or {}
        price = price_block.get("promo") or price_block.get("regular")
        if not price:
            continue
        words = {_stem(w) for w in product.get("description", "").split()}
        hits = len(want & words)
        package_g = _parse_grams(item.get("size", ""))
        ranked.append(((hits < len(want), -hits, rank), {
            "price": round(float(price), 2),
            "label": f"{product.get('description', '')} · {item.get('size', '')}".strip(" ·"),
            "package_g": package_g,
            **_aisle(product.get("aisleLocations") or []),
            "where": keep_where(product),
            "source": "kroger",
            "stock": (item.get("inventory") or {}).get("stockLevel"),
            "url": _product_url(product),
            "nutrition": _kroger_label(product, package_g),
        }))
    if not ranked:
        return None
    ranked.sort(key=lambda r: r[0])
    key, best = ranked[0]
    if key[1] >= 0:
        return None       # not one word of the name in it: no match beats a wrong one
    # the other sizes of what matched as well as the best one did -- what a bulk buy picks from
    sizes = {}
    for k, r in ranked:
        if k[:2] == key[:2] and r["package_g"] and r["package_g"] != best["package_g"]:
            g = round(r["package_g"])
            if g not in sizes or r["price"] < sizes[g]["price"]:
                sizes[g] = {f: r[f] for f in ("price", "package_g", "label")}
    return {**best, "options": sorted(sizes.values(), key=lambda o: o["package_g"])[:6]}


# ── what the list asks for ───────────────────────────────────────────────

def price_for(ingredient: dict, shop: Optional[dict], allow_network: bool = True) -> Optional[dict]:
    """The best price known for one ingredient at one store.

    A live lookup happens only when the store is a Kroger banner, the
    credentials are set, and what's remembered is either missing or stale
    -- so a list of forty items doesn't fire forty requests every time it
    redraws."""
    from .places import chain_of

    known = remembered(ingredient["id"], shop)
    fresh_enough = known and (known.get("source") != "kroger"
                              or (time.time() - known.get("updated_at", 0) < LIVE_TTL
                                  and "aisle_num" in known and "options" in known
                                  and "nutrition" in known and "where" in known))   # saved before those were kept
    if known and fresh_enough:
        return _aged(known)
    if not allow_network or not shop or chain_of(shop) != "kroger" or not kroger_configured():
        return _aged(known)

    location_id = kroger_location_id(shop)
    live = kroger_price(ingredient["name"], location_id) if location_id else None
    if live is None:
        return _aged(known)
    entry = remember(ingredient["id"], shop, live["price"], live.get("package_g"),
                     live.get("label", ""), source="kroger",
                     aisle={k: live.get(k) for k in ("aisle", "aisle_num", "aisle_bay", "where")},
                     options=live.get("options", []), nutrition=live.get("nutrition"), with_nutrition=True,
                     stock=live.get("stock"), url=live.get("url"))
    if live.get("nutrition"):
        _bind_label(ingredient)
    _remember_where(ingredient, live.get("where"))
    return {**entry, "age_days": 0}


def _remember_where(ingredient: dict, where: Optional[str]) -> None:
    """What the store says about where it's kept becomes the ingredient's own `bought_to` -- unless someone
    already said where it lives (the Pantry's fridge / dry / freezer buttons set `storage` by hand)."""
    if not where or ingredient.get("storage_by_hand") or ingredient.get("bought_to") == where:
        return
    from . import ingredients
    try:
        ingredients.update(ingredient["id"], bought_to=where)
    except Exception:
        pass


def _bind_label(ingredient: dict) -> None:
    """A new label from the store: the ingredient takes it when it passes brands.py's checks."""
    from . import brands
    try:
        brands.bind(ingredient["id"], kroger_only=True)
    except Exception:
        pass       # a label is a bonus on a price lookup, never a reason for one to fail


def kroger_label_for(ingredient_id: str) -> list[dict]:
    """Kroger labels of what the stores matched for this ingredient, newest first."""
    rows = [r[ingredient_id] for r in _load().get("prices", {}).values()
            if ingredient_id in r and r[ingredient_id].get("nutrition")]
    rows.sort(key=lambda r: -(r.get("updated_at") or 0))
    return [{**r["nutrition"], "package_g": r.get("package_g")} for r in rows]


def _aged(entry: Optional[dict]) -> Optional[dict]:
    """A remembered price with "how long ago" attached -- the UI never
    shows a price without saying how old it is."""
    if not entry:
        return None
    return {**entry, "age_days": round((time.time() - entry.get("updated_at", 0)) / 86400)}


def packages_needed(planned_g: float, package_g: Optional[float]) -> int:
    """How many of a thing to buy. Unknown package size means one -- an
    honest floor, and the UI marks it."""
    if not package_g or package_g <= 0 or not planned_g:
        return 1
    return max(1, math.ceil(planned_g / package_g))


# ── low or out at the picked store: where else nearby has it ────────────────

LOW_STOCK = {"LOW", "TEMPORARILY_OUT_OF_STOCK"}
NEARBY_KM = 15.0


def is_low(entry: Optional[dict]) -> bool:
    return bool(entry) and entry.get("stock") in LOW_STOCK


def elsewhere(ingredient: dict, shop: Optional[dict], limit: int = 4) -> dict:
    """Other shops near the picked one that stock this ingredient, nearest first. Only Kroger
    banners can be CHECKED (their API says the stock level per store), so only those are
    offered as 'has it'; every answer carries a link to the shop (its own site, else a map)."""
    from . import places

    if not shop or shop.get("lat") is None or not kroger_configured():
        return {"stores": [], "checked": 0}
    cands = []
    for s in places.stores_near(shop["lat"], shop["lon"], "grocery"):
        if s.get("id") == shop.get("id") or places.chain_of(s) != "kroger":
            continue
        if s.get("distance_km", 0) <= NEARBY_KM:
            cands.append(s)
    out, checked = [], 0
    for s in cands[:8]:
        loc = kroger_location_id(s)
        if not loc:
            continue
        checked += 1
        hit = kroger_price(ingredient["name"], loc)
        if not hit or hit.get("stock") in LOW_STOCK:
            continue
        out.append({"name": s["name"], "address": s.get("address", ""),
                    "distance_km": s.get("distance_km"), "price": hit["price"],
                    "label": hit.get("label", ""), "stock": hit.get("stock"),
                    "product_url": hit.get("url"), "store_url": _store_url(s)})
        if len(out) >= limit:
            break
    return {"stores": out, "checked": checked}


def _store_url(s: dict) -> str:
    """The shop's own site when OpenStreetMap has one, else a map pin."""
    if s.get("website"):
        return s["website"]
    q = urllib.parse.quote_plus(f"{s.get('name', '')} {s.get('address', '')}".strip())
    return f"https://www.google.com/maps/search/?api=1&query={q}"
