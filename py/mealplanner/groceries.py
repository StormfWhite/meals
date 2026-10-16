"""The week's grocery checklist: what the planned recipes actually need,
merged with what's been checked off / bought / sorted into a section.

Quantities are aggregated once per *cook event*, not once per slot -- a
leftover_group represents one batch spanning several meals, so its
ingredients are only counted once (from whichever linked slot is seen
first) or the grocery list would ask for several times the eggplant a
recipe actually needs.
"""
from __future__ import annotations

import uuid
from typing import Optional

from . import aisles, board, ingredients, learning, nutrition, places, prices, recipes, store
from .paths import GROCERIES_FILE


def _load() -> dict:
    return store.load(GROCERIES_FILE, {"weeks": {}})


def _save(data: dict) -> None:
    store.save(GROCERIES_FILE, data)


def week_ingredient_needs(week_start_iso: str) -> dict[str, float]:
    """ingredient_id -> grams needed, counting each leftover_group once."""
    week = board.get_week(week_start_iso)
    ing_by_id = ingredients.by_id()
    seen_groups: set[str] = set()
    needs: dict[str, float] = {}

    for slot in week["slots"].values():
        gid = slot.get("leftover_group")
        if gid:
            if gid in seen_groups:
                continue
            seen_groups.add(gid)
        recipe = recipes.get(slot["recipe_id"])
        if recipe is None:
            continue
        ing_list = slot.get("ingredient_overrides") or recipe["ingredients"]
        for item in ing_list:
            ing = ing_by_id.get(item["ingredient_id"])
            if ing is None:
                continue
            grams = nutrition.qty_to_grams(ing, item["qty"], item["unit"])
            if grams is None:
                continue
            needs[item["ingredient_id"]] = needs.get(item["ingredient_id"], 0.0) + grams
    return needs


def active_shop(kind: str = "grocery") -> Optional[dict]:
    """The store (or market) prices are quoted against: whichever one the
    active place has picked."""
    place = places.active()
    if not place:
        return None
    return place.get("market" if kind == "market" else "store")


def get_week_groceries(week_start_iso: str, with_prices: bool = True,
                       allow_network: bool = False) -> list[dict]:
    """Recipe-derived needs (seeded by the learning loop) merged with
    hand-added `extra_items` -- extras are added on top raw, after seeding,
    since they're an explicit "I want this much" rather than a recipe
    quantity the learning loop should be nudging.

    Every item carries the list it belongs on (`shop_list`), which is what
    splits the panel into groceries and farmer's market. Nothing decides
    that here: aisles.py owns the rule and the ingredient owns the answer,
    so an item moved by hand stays moved.

    `allow_network` is off by default deliberately -- a list redraw must
    never turn into forty Kroger requests. Live prices are fetched by an
    explicit refresh (see server.py) and remembered afterwards.
    """
    needs = week_ingredient_needs(week_start_iso)
    ing_by_id = ingredients.by_id()
    week_data = _load()["weeks"].get(week_start_iso, {})
    saved = week_data.get("items", {})
    extra = week_data.get("extra_items", {})

    extra_ids = set(extra)
    grams_by_id = {ing_id: learning.seeded_quantity(ing_id, grams) for ing_id, grams in needs.items()}
    for ing_id, ex in extra.items():
        grams_by_id[ing_id] = grams_by_id.get(ing_id, 0.0) + ex["qty_g"]

    shops = {"grocery": active_shop("grocery"), "market": active_shop("market")}
    out = []
    for ing_id, grams in grams_by_id.items():
        ing = ing_by_id.get(ing_id)
        if ing is None:
            continue
        s = saved.get(ing_id, {})
        shop_list = aisles.list_for(ing)
        item = {
            "ingredient_id": ing_id,
            "name": ing["name"],
            "planned_qty_g": round(grams, 1),
            "bought_qty_g": s.get("bought_qty_g"),
            "unit_label": ingredients.humanize_grams(ing, grams),
            "section": s.get("section", ing.get("store_section")),
            "checked": s.get("checked", False),
            "source": "extra" if ing_id in extra_ids else "recipe",
            "shop_list": shop_list,
            "category": ing.get("category", "other"),
            "fdc_matched": bool(ing.get("fdc_id")),
        }
        if with_prices:
            item.update(_priced(ing, item, shops[shop_list], allow_network))
        out.append(item)
    out.sort(key=lambda r: r["name"].lower())
    return out


def _priced(ingredient: dict, item: dict, shop: Optional[dict], allow_network: bool) -> dict:
    """Price fields for one row: what one costs, how many you need, and
    what that comes to. Missing stays missing -- an item with no price
    contributes nothing to the total and is counted as unpriced instead,
    because a total that quietly skips items reads as complete."""
    price = prices.price_for(ingredient, shop, allow_network=allow_network)
    if not price:
        return {"price": None, "packages": None, "est_cost": None,
                "price_source": None, "price_age_days": None, "price_label": ""}
    packages = prices.packages_needed(item["planned_qty_g"], price.get("package_g"))
    return {
        "price": price["price"],
        "packages": packages,
        "est_cost": round(price["price"] * packages, 2),
        "price_source": price.get("source"),
        "price_age_days": price.get("age_days"),
        "price_label": price.get("label", ""),
        "aisle": price.get("aisle", ""),
    }


def list_totals(items: list[dict]) -> dict:
    """Per-list estimated cost, with the honesty counter beside it."""
    out = {}
    for shop_list in (aisles.GROCERY, aisles.MARKET):
        rows = [i for i in items if i.get("shop_list") == shop_list and not i.get("checked")]
        priced = [i for i in rows if i.get("est_cost") is not None]
        out[shop_list] = {
            "items": len(rows),
            "estimated": round(sum(i["est_cost"] for i in priced), 2) if priced else None,
            "unpriced": len(rows) - len(priced),
        }
    return out


def add_extra_item(week_start_iso: str, ingredient_id: str, qty_g: float) -> list[dict]:
    """A catalog item added straight to the grocery list, not derived from
    any planned recipe -- repeated adds accumulate rather than overwrite."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    extras = week.setdefault("extra_items", {})
    existing = extras.get(ingredient_id, {}).get("qty_g", 0.0)
    extras[ingredient_id] = {"qty_g": existing + qty_g}
    _save(data)
    return get_week_groceries(week_start_iso)


def remove_extra_item(week_start_iso: str, ingredient_id: str) -> list[dict]:
    data = _load()
    week = data["weeks"].get(week_start_iso, {})
    week.get("extra_items", {}).pop(ingredient_id, None)
    _save(data)
    return get_week_groceries(week_start_iso)


# ── free list ────────────────────────────────────────────────────────────
#
# A completely separate, unstructured list ("3 eggplant", "two tomatoes")
# for a farmer's-market-style trip that doesn't map to recipe ingredients.
# Deliberately no quantity/word parsing -- it's stored and exported exactly
# as typed, trading structure for zero friction.

def list_free_items(week_start_iso: str) -> list[dict]:
    return _load()["weeks"].get(week_start_iso, {}).get("free_list", [])


def add_free_item(week_start_iso: str, text: str) -> list[dict]:
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    week.setdefault("free_list", []).append({
        "id": "f_" + uuid.uuid4().hex[:8], "text": text.strip(), "checked": False,
    })
    _save(data)
    return week["free_list"]


def update_free_item(week_start_iso: str, item_id: str, fields: dict) -> list[dict]:
    data = _load()
    week = data["weeks"].get(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    item = next((i for i in week.get("free_list", []) if i["id"] == item_id), None)
    if item is None:
        raise KeyError(item_id)
    for key in ("text", "checked"):
        if key in fields and fields[key] is not None:
            item[key] = fields[key].strip() if key == "text" else fields[key]
    _save(data)
    return week["free_list"]


def delete_free_item(week_start_iso: str, item_id: str) -> list[dict]:
    data = _load()
    week = data["weeks"].get(week_start_iso, {})
    before = len(week.get("free_list", []))
    week["free_list"] = [i for i in week.get("free_list", []) if i["id"] != item_id]
    _save(data)
    if len(week["free_list"]) == before:
        raise KeyError(item_id)
    return week["free_list"]


def free_list_export_text(week_start_iso: str) -> str:
    items = list_free_items(week_start_iso)
    if not items:
        return "(nothing on the free list)"
    return "\n".join(f"- {i['text']}" for i in items)


def update_item(week_start_iso: str, ingredient_id: str, fields: dict) -> dict:
    """`fields` holds only the keys the caller actually sent (see server.py's
    `exclude_unset`) -- unlike a plain None-means-skip signature, this lets
    a bought quantity be explicitly cleared back to "not yet bought"."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}})
    item = week["items"].setdefault(ingredient_id, {})
    for key in ("bought_qty_g", "section", "checked"):
        if key in fields:
            item[key] = fields[key]
    _save(data)
    matches = [i for i in get_week_groceries(week_start_iso) if i["ingredient_id"] == ingredient_id]
    return matches[0] if matches else {}


def set_section(week_start_iso: str, ingredient_id: str, section: Optional[str]) -> dict:
    """Unconditional, unlike update_item's partial-update semantics -- this
    is the dedicated section-move endpoint, so `None` means "back to
    Unsorted", not "leave it alone"."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}})
    item = week["items"].setdefault(ingredient_id, {})
    item["section"] = section
    _save(data)
    matches = [i for i in get_week_groceries(week_start_iso) if i["ingredient_id"] == ingredient_id]
    return matches[0] if matches else {}


def get_allocation(week_start_iso: str) -> list[dict]:
    out = []
    for item in get_week_groceries(week_start_iso):
        bought = item["bought_qty_g"]
        planned = item["planned_qty_g"]
        if bought is None:
            out.append({**item, "claimed_qty_g": None, "unclaimed_qty_g": None, "overcommitted_g": None})
            continue
        out.append({
            **item,
            "claimed_qty_g": round(min(bought, planned), 1),
            "unclaimed_qty_g": round(max(0.0, bought - planned), 1),
            "overcommitted_g": round(max(0.0, planned - bought), 1),
        })
    return out


def export_text(week_start_iso: str, section: str) -> str:
    items = [i for i in get_week_groceries(week_start_iso) if i["section"] == section]
    if not items:
        return "(nothing needed)"
    return "\n".join(f"- {i['unit_label']} {i['name']}" for i in items)
