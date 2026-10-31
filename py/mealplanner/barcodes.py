"""A barcode Open Food Facts doesn't know, asked of USDA's Branded Foods (every product a US manufacturer or
store reports -- Whole Foods' 365, Trader Joe's, Kroger's own labels): the search takes the UPC as its query and
the record carries it back as `gtinUpc`, so the match is exact, never a guess by name.

Goes through fdc.get_json, so on the phone the page fetches the URL (fdc.JS_RESPONSES / NeedFetch) like every other
USDA call.
"""
from __future__ import annotations

import re
from typing import Optional

from . import fdc

_AMOUNT = re.compile(r"(\d+(?:\.\d+)?)\s*(g|gram|grams|oz|ounce|ounces|lb|lbs|ml|l|fl\.? ?oz)\b", re.I)


def _pretty(s: str) -> str:
    s = (s or "").strip()
    return s.title() if s.isupper() else s


def _qty(food: dict) -> str:
    """"425 g" from whatever the label record says: packageWeight ("15 OZ (425 g)"), else the serving size
    times nothing -- an unknown size is left blank so the page asks, never guessed."""
    text = food.get("packageWeight") or ""
    found = _AMOUNT.findall(text)
    if not found:
        return ""
    grams = next(((a, u) for a, u in found if u.lower() in ("g", "gram", "grams")), None)
    a, u = grams or found[0]
    return f"{a} {u}"


def lookup(code: str) -> Optional[dict]:
    """{name, qty} for a UPC / EAN, or None. Leading zeros don't matter (UPC-A 12 digits vs EAN-13)."""
    code = re.sub(r"\D", "", code or "")
    if len(code) < 8 or not fdc.available():
        return None
    data = fdc._get("/foods/search", {"query": code, "dataType": "Branded", "pageSize": 10})
    for f in (data or {}).get("foods", []):
        if (f.get("gtinUpc") or "").lstrip("0") == code.lstrip("0"):
            brand = _pretty(f.get("brandName") or f.get("brandOwner") or "")
            desc = _pretty(f.get("description") or "")
            name = desc if not brand or brand.lower() in desc.lower() else f"{brand} {desc}"
            return {"name": name, "qty": _qty(f)}
    return None
