"""Where you live and where you shop.

Two moving parts, kept together because one is meaningless without the
other:

  places   the handful of home bases you actually cook in (Storm has two:
           E.S. King Village at NC State, and Chatsworth CA). Each one
           remembers its own grocery store and its own farmer's market,
           because switching coasts shouldn't mean re-picking a store.
  stores   real shops near a place, from OpenStreetMap, so "harris teeter"
           completes to *the* Harris Teeter on Oberlin Road with its
           address -- not a name you typed into a box.

**Overpass for the list, Photon only as a fallback.** Photon's `lat`/`lon`
are a *bias*, not a filter, and it is easily overwhelmed by name matching:
searching "grocery" biased to Raleigh returns shops in Dubai, measured.
So the store list for a place is fetched once from Overpass (a real
radius query around the coordinates), cached, and then *filtered locally*
as you type -- which also means the typeahead costs nothing per keystroke.
Photon is still the right tool for finding the place itself, where the
query is a name or an address rather than "what's near here".
"""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
import uuid
from typing import Optional

from . import store
from .paths import PLACES_FILE, STORES_CACHE_FILE

PHOTON = "https://photon.komoot.io/api/"
OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "meal-planner/1.0 (personal meal planning app)"

GROCERY_RADIUS_M = 8000     # a store you'd actually drive to for a weekly shop
MARKET_RADIUS_M = 25000     # a farmer's market is worth a longer trip
STORE_CACHE_TTL = 14 * 24 * 3600   # shops don't open and close weekly

# Kroger's public API covers every banner the company owns, so a store
# whose OSM brand is one of these can have live prices if credentials are
# set. Anything else falls back to remembered prices (see prices.py).
KROGER_BANNERS = {
    "kroger", "harris teeter", "fred meyer", "ralphs", "king soopers",
    "smith's", "smiths", "fry's", "frys", "qfc", "dillons", "baker's",
    "bakers", "gerbes", "jay c", "pay less", "pick 'n save", "metro market",
    "mariano's", "marianos", "food 4 less", "foods co", "city market",
}


# ── the saved places ─────────────────────────────────────────────────────

def _load() -> dict:
    return store.load(PLACES_FILE, {"places": [], "active_id": None})


def _save(data: dict) -> None:
    store.save(PLACES_FILE, data)


def list_places() -> list[dict]:
    return _load()["places"]


def active() -> Optional[dict]:
    data = _load()
    if not data["places"]:
        return None
    found = next((p for p in data["places"] if p["id"] == data.get("active_id")), None)
    return found or data["places"][0]


def add_place(label: str, lat: float, lon: float, address: str = "") -> dict:
    data = _load()
    place = {
        "id": "p_" + uuid.uuid4().hex[:8],
        "label": label.strip() or "Home",
        "lat": float(lat),
        "lon": float(lon),
        "address": address,
        "store": None,
        "market": None,
    }
    data["places"].append(place)
    if not data.get("active_id"):
        data["active_id"] = place["id"]
    _save(data)
    return place


def update_place(place_id: str, **fields) -> dict:
    data = _load()
    place = next((p for p in data["places"] if p["id"] == place_id), None)
    if place is None:
        raise KeyError(place_id)
    for key in ("label", "lat", "lon", "address", "store", "market"):
        if key in fields and fields[key] is not None:
            place[key] = fields[key]
    _save(data)
    return place


def delete_place(place_id: str) -> bool:
    data = _load()
    before = len(data["places"])
    data["places"] = [p for p in data["places"] if p["id"] != place_id]
    if data.get("active_id") == place_id:
        data["active_id"] = data["places"][0]["id"] if data["places"] else None
    _save(data)
    return len(data["places"]) < before


def set_active(place_id: str) -> dict:
    data = _load()
    if not any(p["id"] == place_id for p in data["places"]):
        raise KeyError(place_id)
    data["active_id"] = place_id
    _save(data)
    return active()


# ── finding a place (Photon: names and addresses) ────────────────────────

def _http_json(url: str, data: Optional[bytes] = None, timeout: int = 25) -> Optional[dict]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _photon_label(props: dict) -> tuple[str, str]:
    name = props.get("name") or props.get("street") or ""
    bits = [b for b in (
        " ".join(x for x in (props.get("housenumber"), props.get("street")) if x),
        props.get("city"), props.get("state"), props.get("postcode"),
    ) if b]
    return name, ", ".join(bits)


def search_places(q: str, limit: int = 6) -> list[dict]:
    """Free-text search for somewhere to live/cook -- an address, a
    building, a neighbourhood."""
    q = (q or "").strip()
    if len(q) < 3:
        return []
    url = PHOTON + "?" + urllib.parse.urlencode({"q": q, "limit": limit})
    data = _http_json(url) or {}
    out = []
    for feature in data.get("features", []):
        props = feature.get("properties", {})
        lon, lat = feature.get("geometry", {}).get("coordinates", [None, None])
        if lat is None:
            continue
        name, address = _photon_label(props)
        if not name:
            continue
        out.append({"name": name, "address": address, "lat": lat, "lon": lon,
                    "country": props.get("country", "")})
    return out


# ── finding a store (Overpass around a place, filtered locally) ──────────

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def _cache_key(lat: float, lon: float, kind: str) -> str:
    return f"{kind}:{lat:.3f},{lon:.3f}"


def _overpass_query(lat: float, lon: float, kind: str) -> str:
    if kind == "market":
        return f"""[out:json][timeout:25];
(
  nwr["amenity"="marketplace"](around:{MARKET_RADIUS_M},{lat},{lon});
  nwr["shop"="farm"](around:{MARKET_RADIUS_M},{lat},{lon});
  nwr["shop"="greengrocer"](around:{MARKET_RADIUS_M},{lat},{lon});
);
out center tags 60;"""
    return f"""[out:json][timeout:25];
(
  nwr["shop"~"^(supermarket|grocery|wholesale)$"](around:{GROCERY_RADIUS_M},{lat},{lon});
);
out center tags 80;"""


OVERPASS_MIRRORS = ("https://overpass.private.coffee/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter")


def _fetch_stores(lat: float, lon: float, kind: str) -> Optional[list[dict]]:
    """None when no server answered -- "no shops here" and "couldn't ask" are different, and
    caching the second as the first left Chatsworth with an empty picker for 14 days (2026-10-18)."""
    body = urllib.parse.urlencode({"data": _overpass_query(lat, lon, kind)}).encode()
    data = None
    for url in (OVERPASS,) + OVERPASS_MIRRORS:
        data = _http_json(url, body, timeout=45)
        if data is not None and "elements" in data:
            break
    else:
        return _nominatim_stores(lat, lon, kind)
    out = []
    for element in data.get("elements", []):
        tags = element.get("tags", {})
        name = tags.get("name")
        if not name:
            continue
        center = element.get("center") or element
        elat, elon = center.get("lat"), center.get("lon")
        if elat is None or elon is None:
            continue
        address = ", ".join(b for b in (
            " ".join(x for x in (tags.get("addr:housenumber"), tags.get("addr:street")) if x),
            tags.get("addr:city"), tags.get("addr:state"), tags.get("addr:postcode"),
        ) if b)
        out.append({
            "id": f"{element.get('type', 'node')}/{element.get('id')}",
            "name": name,
            "brand": tags.get("brand") or "",
            "kind": tags.get("shop") or tags.get("amenity") or "",
            "address": address,
            "postcode": tags.get("addr:postcode") or "",
            "lat": elat,
            "lon": elon,
            "distance_km": round(_haversine_km(lat, lon, elat, elon), 2),
        })
    out.sort(key=lambda s: s["distance_km"])
    return out


NOMINATIM = "https://nominatim.openstreetmap.org/search"
NOMINATIM_QUERIES = {"grocery": ("supermarket", "grocery"), "market": ("farmers market", "marketplace")}
MARKET_TYPES = {"marketplace", "farm", "greengrocer"}


def _nominatim_stores(lat: float, lon: float, kind: str, box_km: float = 8.0) -> Optional[list[dict]]:
    """The fallback when every Overpass server is down (2026-10-18: one timing out, both mirrors
    500): Nominatim's category search, bounded to a box round the point. Its usage policy is one
    request a second with a real User-Agent, hence the pause."""
    dlat = box_km / 111.0
    dlon = box_km / (111.0 * max(0.2, math.cos(math.radians(lat))))
    seen, out, answered = set(), [], False
    for i, q in enumerate(NOMINATIM_QUERIES.get(kind, NOMINATIM_QUERIES["grocery"])):
        if i:
            time.sleep(1.1)
        url = NOMINATIM + "?" + urllib.parse.urlencode({
            "q": q, "format": "jsonv2", "limit": 50, "bounded": 1, "addressdetails": 1,
            "viewbox": f"{lon - dlon},{lat + dlat},{lon + dlon},{lat - dlat}"})
        rows = _http_json(url, timeout=20)
        if rows is None:
            continue
        answered = True
        for r in rows:
            typ = r.get("type", "")
            if kind == "market" and typ not in MARKET_TYPES:
                continue                 # "Sprouts Farmers Market" is a supermarket
            if kind == "grocery" and typ in MARKET_TYPES:
                continue
            key = f"{r.get('osm_type', 'node')}/{r.get('osm_id')}"
            if not r.get("name") or key in seen:
                continue
            seen.add(key)
            a = r.get("address") or {}
            elat, elon = float(r["lat"]), float(r["lon"])
            out.append({
                "id": key, "name": r["name"], "brand": "", "kind": typ,
                "address": ", ".join(b for b in (" ".join(x for x in (a.get("house_number"), a.get("road")) if x),
                                                 a.get("city") or a.get("town") or a.get("suburb"), a.get("state"),
                                                 a.get("postcode")) if b),
                "postcode": a.get("postcode") or "", "lat": elat, "lon": elon,
                "distance_km": round(_haversine_km(lat, lon, elat, elon), 2),
            })
    if not answered:
        return None
    out.sort(key=lambda s: s["distance_km"])
    return out


def stores_near(lat: float, lon: float, kind: str = "grocery", refresh: bool = False) -> list[dict]:
    """Every shop of `kind` around a point, cached -- the list the
    typeahead filters. One network call per place per fortnight."""
    cache = store.load(STORES_CACHE_FILE, {})
    key = _cache_key(lat, lon, kind)
    hit = cache.get(key)
    if hit and not refresh and time.time() - hit.get("fetched_at", 0) < STORE_CACHE_TTL:
        return hit["stores"]
    fetched = _fetch_stores(lat, lon, kind)
    if fetched is None or (not fetched and hit):
        return hit["stores"] if hit else []   # a failed fetch is never cached, nor empties the picker
    cache[key] = {"fetched_at": time.time(), "stores": fetched}
    store.save(STORES_CACHE_FILE, cache)
    return fetched


NEAR_HOME_KM = 5.0
HOME_SWITCH_KM = 25.0


def arrived(lat: float, lon: float) -> Optional[dict]:
    """A phone says where it is: when that's near a saved home other than the active one, that
    home becomes active -- for every device, the laptop included (it has no location of its own).
    Storm 2026-10-18: the planner kept saying "near E S King Village" while they were in Chatsworth."""
    near = min(list_places(), key=lambda p: _haversine_km(lat, lon, p["lat"], p["lon"]), default=None)
    if not near or _haversine_km(lat, lon, near["lat"], near["lon"]) > HOME_SWITCH_KM:
        return None
    cur = active()
    if cur and cur["id"] == near["id"]:
        return None
    return set_active(near["id"])


def spot_for(lat: Optional[float], lon: Optional[float]) -> tuple[float, float, str]:
    """Where to look for shops: the phone's position, snapped to a saved home when within
    NEAR_HOME_KM (that home's store list is already cached), else the position itself (one
    Overpass fetch, then cached). No position = the active home."""
    home = active()
    if lat is None or lon is None:
        return (home["lat"], home["lon"], home["label"]) if home else (None, None, "")
    near = min(list_places(), key=lambda p: _haversine_km(lat, lon, p["lat"], p["lon"]), default=None)
    if near and _haversine_km(lat, lon, near["lat"], near["lon"]) <= NEAR_HOME_KM:
        return near["lat"], near["lon"], "you"      # that home's cached list; it IS where you are
    return round(lat, 3), round(lon, 3), "you"


def cached_stores(lat: float, lon: float, kind: str = "grocery") -> Optional[list[dict]]:
    """The last fetched list for this spot however old, or None -- for callers that must never
    wait on Overpass (the phone's trip watch: a cold fetch took 79 s)."""
    hit = store.load(STORES_CACHE_FILE, {}).get(_cache_key(lat, lon, kind))
    return hit["stores"] if hit else None


def search_stores(q: str, lat: float, lon: float, kind: str = "grocery",
                  limit: int = 8) -> list[dict]:
    """Type-to-filter over the cached nearby shops, nearest first.

    An empty query is meaningful here (it's "what's near me"), unlike the
    place search -- which is why this doesn't bail on a short string."""
    nearby = stores_near(lat, lon, kind)
    needle = (q or "").strip().lower()
    if needle:
        scored = []
        for shop in nearby:
            haystack = f"{shop['name']} {shop['brand']} {shop['address']}".lower()
            if needle in haystack:
                # a name match beats an address match, then nearest wins
                rank = 0 if shop["name"].lower().startswith(needle) else (
                    1 if needle in shop["name"].lower() else 2)
                scored.append((rank, shop["distance_km"], shop))
        scored.sort(key=lambda s: (s[0], s[1]))
        matches = [s[2] for s in scored]
    else:
        matches = nearby
    return [{**s, "chain": chain_of(s)} for s in matches[:limit]]


def chain_of(shop: dict) -> Optional[str]:
    """"kroger" if this shop is a Kroger banner (so prices can be live),
    else None."""
    for field in (shop.get("brand"), shop.get("name")):
        lowered = (field or "").strip().lower()
        if lowered in KROGER_BANNERS:
            return "kroger"
    return None
