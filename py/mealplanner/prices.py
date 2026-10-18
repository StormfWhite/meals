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
             source: str = "typed") -> dict:
    data = _load()
    per_store = data["prices"].setdefault(_store_key(shop), {})
    entry = {
        "price": round(float(price), 2),
        "package_g": package_g,
        "label": label,
        "source": source,
        "updated_at": time.time(),
    }
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
    m = re.match(r"^([\d.]+)\s*(oz|ounce|ounces|lb|lbs|pound|pounds|g|gram|grams|kg)\b", text)
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


# Not food -- a search for "hemp seeds" ranked an Epsom-salt soak (Personal Care) next to Hemp
# Hearts, "cashew butter" found a baby-food pouch (2026-10-18).
NON_FOOD = {"personal care", "health & beauty", "beauty", "baby", "pet care", "pet", "cleaning products",
            "household", "paper & plastic products", "home & garden", "kitchen", "health", "pharmacy"}


def _stem(word: str) -> str:
    word = word.lower().strip(".,®™'’")
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


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
        ranked.append(((hits < len(want), -hits, rank), {
            "price": round(float(price), 2),
            "label": f"{product.get('description', '')} · {item.get('size', '')}".strip(" ·"),
            "package_g": _parse_grams(item.get("size", "")),
            "aisle": ", ".join(a.get("description", "") for a in (product.get("aisleLocations") or [])[:1]),
            "source": "kroger",
        }))
    if not ranked:
        return None
    ranked.sort(key=lambda r: r[0])
    key, best = ranked[0]
    return best if key[1] < 0 else None       # not one word of the name in it: no match beats a wrong one


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
                              or time.time() - known.get("updated_at", 0) < LIVE_TTL)
    if known and fresh_enough:
        return _aged(known)
    if not allow_network or not shop or chain_of(shop) != "kroger" or not kroger_configured():
        return _aged(known)

    location_id = kroger_location_id(shop)
    live = kroger_price(ingredient["name"], location_id) if location_id else None
    if live is None:
        return _aged(known)
    entry = remember(ingredient["id"], shop, live["price"], live.get("package_g"),
                     live.get("label", ""), source="kroger")
    return {**entry, "aisle": live.get("aisle", ""), "age_days": 0}


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
