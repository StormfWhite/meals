"""The week's grocery checklist: what the planned recipes actually need,
merged with what's been checked off / bought / sorted into a section.

Quantities are aggregated once per *cook event*, not once per slot -- a
leftover_group represents one batch spanning several meals, so its
ingredients are only counted once (from whichever linked slot is seen
first) or the grocery list would ask for several times the eggplant a
recipe actually needs.
"""
from __future__ import annotations

import datetime
import json
import re
import uuid
from typing import Optional

from . import aisles, board, config, ingredients, learning, nutrition, places, prices, recipes, stock, store
from .paths import DATA_DIR, GROCERIES_FILE, PRICE_HISTORY_FILE


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
            # a unit with no known weight ("1 bunch") is still something to buy:
            # it stays on the list, just without an amount
            grams = nutrition.qty_to_grams(ing, item["qty"], item["unit"]) or 0.0
            needs[item["ingredient_id"]] = needs.get(item["ingredient_id"], 0.0) + grams
    return needs


def week_ingredient_meals(week_start_iso: str) -> tuple[dict[str, list[str]], list[str]]:
    """(ingredient_id -> the names of the week's meals that use it, every meal name in the
    order they're cooked: day, then breakfast/lunch/dinner) -- what the list groups itself by."""
    week = board.get_week(week_start_iso)
    meal_rank = {m: i for i, m in enumerate(board.MEALS)}

    def when(key: str):
        date, meal, index = board.parse_slot_key(key)
        return date, meal_rank.get(meal, 9), index

    out: dict[str, list[str]] = {}
    order: list[str] = []
    for key in sorted(week["slots"], key=when):
        slot = week["slots"][key]
        recipe = recipes.get(slot.get("recipe_id"))
        if recipe is None:
            continue
        if recipe["name"] not in order:
            order.append(recipe["name"])
        for item in slot.get("ingredient_overrides") or recipe["ingredients"]:
            names = out.setdefault(item["ingredient_id"], [])
            if recipe["name"] not in names:
                names.append(recipe["name"])
    return out, order


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
        grams_by_id[ing_id] = grams_by_id.get(ing_id, 0.0) + ex.get("qty_g", 0.0)

    shops = {"grocery": active_shop("grocery"), "market": active_shop("market")}
    ledger = stock.Ledger()
    on_hand = ledger.state(week_start_iso)
    meals_of, cooked = week_ingredient_meals(week_start_iso)
    meal_order = {name: i for i, name in enumerate(cooked)}
    out = []
    for ing_id, grams in grams_by_id.items():
        ing = ing_by_id.get(ing_id)
        if ing is None:
            continue
        s = saved.get(ing_id, {})
        # Swiped off: stays off until the plan needs MORE of it than it did then.
        if s.get("removed_g") is not None and grams <= s["removed_g"] + 0.5:
            continue
        # typed into one list's box = on that list (this week), whatever aisles.py would say
        shop_list = s.get("shop_list") or aisles.list_for(ing)
        typed = extra.get(ing_id, {}).get("qty_text", "")
        # what's on hand first, then whole packages (stock.py): the row asks for what to BUY
        have = ledger.total(on_hand.get(ing_id, []))
        buy = ledger.row_buy(week_start_iso, ing_id, have)
        need = ledger.needs(week_start_iso).get(ing_id, 0.0)
        covered = need > 0 and buy["to_buy_g"] == 0 and ing_id not in extra_ids
        to_buy = buy["to_buy_g"] if buy["to_buy_g"] is not None else 0.0
        if ing.get("default_unit", "g") == "g" or not to_buy:
            label = stock.us_amount(to_buy)
        else:
            label = ingredients.humanize_grams(ing, to_buy)
        if extra.get(ing_id, {}).get("qty_text") and ing_id not in needs:
            label = ""                        # a hand-add's typed amount says it already
        if s.get("qty_text") is not None:     # the amount typed on the list row itself wins
            label, typed = "", s["qty_text"]
        item = {
            "ingredient_id": ing_id,
            "name": ing["name"],
            "planned_qty_g": round(grams, 1),
            "bought_qty_g": s.get("bought_qty_g"),
            # a name added with no amount has no amount -- never a made-up "0 g";
            # a typed amount shows as typed, beside whatever the meals need
            "unit_label": " + ".join(t for t in (label, typed) if t),
            "section": s.get("section", ing.get("store_section")),
            "checked": s.get("checked", False),
            "source": "extra" if ing_id in extra_ids else "recipe",
            "shop_list": shop_list,
            "category": ing.get("category", "other"),
            "fdc_matched": bool(ing.get("fdc_id")),
            # the week's meals that use it, cooked-first first; the list groups under meals[0]
            "meals": meals_of.get(ing_id, []),
            "meal_order": meal_order.get(meals_of[ing_id][0]) if meals_of.get(ing_id) else None,
            # the leftover math (stock.py)
            "need_g": round(need, 1),
            "need_text": stock.us_amount(need),
            "on_hand_g": round(have, 1),
            "to_buy_g": None if buy["to_buy_g"] is None else round(buy["to_buy_g"], 1),
            "buy_g": None if buy["buy_g"] is None else round(buy["buy_g"], 1),
            "packages": buy["packages"],
            "covered": covered,
            "freezes": stock.keeps(ing)[1],
            "keep_days": stock.keeps(ing)[0],
        }
        if with_prices:
            look = ledger.outlook(week_start_iso, ing_id, buy["buy_g"] or 0.0)
            item.update({k: (round(v, 1) if isinstance(v, float) else v) for k, v in look.items()})
            item["package"] = s.get("package")
            item.update(_priced(ing, item, shops[shop_list], allow_network))
            item["bulk"] = None if covered or s.get("package") else ledger.bulk(week_start_iso, ing_id, to_buy)
        out.append(item)
    out.sort(key=lambda r: r["name"].lower())
    if with_prices:
        _record_prices(week_start_iso, out)
    return out


# ── price history ────────────────────────────────────────────────────────
#
# Every week's prices, kept beside the data (price_history.json, so in Dropbox) for whatever
# they're wanted for later -- Storm 2026-10-18: "track the grocery prices over time and store them
# for each week … i just want the data". Nothing reads it yet. Shape:
#   {"weeks": {"2026-10-18": {
#       "grocery": {"store": "Ralphs", "total": 44.25, "unpriced": 1},
#       "market":  {"store": null,     "total": null,  "unpriced": 0},
#       "items": {"<ingredient id>": {"name": "Milk", "list": "grocery", "price": 3.19,
#                 "product": "Ralphs 2% … · 1/2 gal", "source": "kroger", "store": "Ralphs",
#                 "first": "2026-10-18", "last": "2026-10-20"}}}}}
# A price that changes mid-week overwrites (the last one seen that week); "first"/"last" say when.

def _record_prices(week_start_iso: str, rows: list[dict]) -> None:
    # only the week being shopped for (or later): opening an old week's list must not stamp
    # today's prices onto it
    if week_start_iso < _monday_target(datetime.date.today()).isoformat():
        return
    shops = {k: active_shop(k) for k in (aisles.GROCERY, aisles.MARKET)}
    today = datetime.date.today().isoformat()
    data = store.load(PRICE_HISTORY_FILE, {"weeks": {}})
    week = data["weeks"].setdefault(week_start_iso, {"items": {}})
    before = json.dumps(week, sort_keys=True)
    totals = list_totals(rows)
    for kind in (aisles.GROCERY, aisles.MARKET):
        week[kind] = {"store": (shops[kind] or {}).get("name"), "total": totals[kind]["estimated"],
                      "unpriced": totals[kind]["unpriced"]}
    for r in rows:
        if r.get("price") is None:
            continue
        prev = week["items"].get(r["ingredient_id"], {})
        week["items"][r["ingredient_id"]] = {
            "name": r["name"], "list": r["shop_list"], "price": r["price"],
            "product": r.get("price_label", ""), "source": r.get("price_source"),
            "store": (shops[r["shop_list"]] or {}).get("name"),
            "first": prev.get("first", today),
            "last": today if prev.get("price") != r["price"] or not prev else prev.get("last", today),
        }
    if json.dumps(week, sort_keys=True) != before:
        store.save(PRICE_HISTORY_FILE, data)


def _priced(ingredient: dict, item: dict, shop: Optional[dict], allow_network: bool) -> dict:
    """Price fields for one row: what one costs, how many you need, and
    what that comes to. Missing stays missing -- an item with no price
    contributes nothing to the total and is counted as unpriced instead,
    because a total that quietly skips items reads as complete."""
    price = prices.price_for(ingredient, shop, allow_network=allow_network)
    if item.get("package"):            # a bigger pack picked on the row (the bulk hint)
        price = {**(price or {}), **item["package"], "source": (price or {}).get("source", "kroger")}
    if not price:
        return {"price": None, "est_cost": None,
                "price_source": None, "price_age_days": None, "price_label": ""}
    if item.get("covered"):            # on hand already: nothing to pay this week
        packages = 0
    elif item.get("package") or item.get("packages") is None:
        packages = prices.packages_needed(item.get("to_buy_g") or item["planned_qty_g"], price.get("package_g"))
    else:
        packages = item["packages"]
    return {
        "price": price["price"],
        "packages": packages,
        "est_cost": round(price["price"] * packages, 2) if packages else None,
        "price_source": price.get("source"),
        "price_age_days": price.get("age_days"),
        "price_label": price.get("label", ""),
        "package_g": price.get("package_g"),
        "aisle": price.get("aisle", ""),
        "aisle_num": price.get("aisle_num"),
        "aisle_bay": price.get("aisle_bay"),
        # a Ralphs price saved before aisles were kept: worth one more lookup (price_missing)
        "aisle_known": price.get("source") != "kroger" or ("aisle_num" in price and "options" in price),
    }


def list_totals(items: list[dict]) -> dict:
    """Per-list estimated cost, with the honesty counter beside it."""
    out = {}
    for shop_list in (aisles.GROCERY, aisles.MARKET):
        mine = [i for i in items if i.get("shop_list") == shop_list]
        rows = [i for i in mine if not i.get("checked") and not i.get("covered")]
        priced = [i for i in rows if i.get("est_cost") is not None]
        out[shop_list] = {
            "items": len(rows),
            "estimated": round(sum(i["est_cost"] for i in priced), 2) if priced else None,
            "unpriced": len(rows) - len(priced),
            "to_freezer": sum(1 for i in mine if (i.get("frozen_g") or 0) > 0.5 and not i.get("covered")),
            "wasted": sum(1 for i in mine if (i.get("wasted_g") or 0) > 0.5 and not i.get("covered")),
            "on_hand": sum(1 for i in mine if i.get("covered")),
        }
    return out


def add_extra_item(week_start_iso: str, ingredient_id: str, qty_g: Optional[float] = None,
                   qty_text: Optional[str] = None, shop_list: Optional[str] = None) -> list[dict]:
    """A catalog item added straight to the grocery list, not derived from
    any planned recipe -- repeated adds accumulate rather than overwrite.
    The amount is optional and is whatever was typed ("2 lb", "a dozen"):
    kept as text, never turned into grams, so a bare name is a whole entry
    and "2 lb" reads back as "2 lb". `qty_g` stays for callers that do
    have a weight."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    extras = week.setdefault("extra_items", {})
    entry = extras.setdefault(ingredient_id, {"qty_g": 0.0})
    entry["qty_g"] = entry.get("qty_g", 0.0) + (qty_g or 0.0)
    if qty_text and qty_text.strip():
        entry["qty_text"] = " + ".join(t for t in (entry.get("qty_text"), qty_text.strip()) if t)
    item = week.setdefault("items", {}).setdefault(ingredient_id, {})
    item.pop("removed_g", None)
    if shop_list in (aisles.GROCERY, aisles.MARKET):
        item["shop_list"] = shop_list
    _save(data)
    return get_week_groceries(week_start_iso)


def remove_item(week_start_iso: str, ingredient_id: str) -> list[dict]:
    """Take a row off this week's list whatever put it there (the swipe):
    a hand-add is dropped, and a recipe need is hidden at today's amount --
    planning more of it later brings it back, since that's a new need."""
    needs = week_ingredient_needs(week_start_iso)
    need = learning.seeded_quantity(ingredient_id, needs[ingredient_id]) if ingredient_id in needs else 0.0
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    week.setdefault("extra_items", {}).pop(ingredient_id, None)
    if need:
        week.setdefault("items", {}).setdefault(ingredient_id, {})["removed_g"] = round(need, 1)
    _save(data)
    return get_week_groceries(week_start_iso)


# ── the usuals ───────────────────────────────────────────────────────────
#
# What gets put on the list by hand week after week (eggs, milk, "basil")
# comes back as a suggestion: tap it and it's real, ✕ it and it's gone for
# that week -- and the ✕ counts against it, so something stopped being
# bought fades out instead of nagging. Recipe needs aren't learned here:
# the plan already puts those on the list.

SUGGEST_LOOKBACK = 8        # weeks of history considered
SUGGEST_DECAY = 0.8         # last week counts 0.8, the week before 0.64, ...
SUGGEST_MIN_WEEKS = 2       # once is a one-off, not a usual
SUGGEST_MIN_SCORE = 0.9     # twice in the last ~3 weeks clears it; twice two months ago doesn't
DISMISS_WEIGHT = 0.5

_LEADING_QTY = re.compile(r"^\s*(?:\d+(?:[./]\d+)?|a few|a couple(?: of)?|some|few)\s*(?:x\b)?\s*", re.I)


def _line_name(text: str) -> str:
    """ "3 eggplant" and "2 eggplant" are the same usual: what's bought, not how many."""
    return _LEADING_QTY.sub("", text).strip()


def _weeks_between(a_iso: str, b_iso: str) -> int:
    return max(1, round((datetime.date.fromisoformat(b_iso) - datetime.date.fromisoformat(a_iso)).days / 7))


def suggestions(week_start_iso: str) -> list[dict]:
    weeks = _load()["weeks"]
    past = sorted(w for w in weeks if w < week_start_iso)[-SUGGEST_LOOKBACK:]
    ing_by_id = ingredients.by_id()
    stats: dict[str, dict] = {}

    def tally(key: str, age: int, sign: float, **fields) -> None:
        st = stats.setdefault(key, {"score": 0.0, "got": 0, **fields})
        st["score"] += sign * SUGGEST_DECAY ** age
        if sign > 0:
            st["got"] += 1
            st.update(fields)   # weeks run oldest-first, so the newest wording wins

    last_week_got: set = set()          # what was on the list just before this one: offered again too
    for w in past:
        wk, age = weeks[w], _weeks_between(w, week_start_iso)
        got = set()
        if w == past[-1]:
            last_week_got = got
        for ing_id in wk.get("extra_items", {}):
            if ing_id in ing_by_id and wk.get("items", {}).get(ing_id, {}).get("removed_g") is None:
                got.add("i:" + ing_id)
                tally("i:" + ing_id, age, 1, ingredient_id=ing_id,
                      box=wk.get("items", {}).get(ing_id, {}).get("shop_list"))
        for line in wk.get("free_list", []):
            name = _line_name(line["text"])
            key = "t:" + name.lower()
            if name and key not in got:
                got.add(key)
                tally(key, age, 1, text=name)
        for key in wk.get("dismissed", []):
            if key not in got:
                tally(key, age, -DISMISS_WEIGHT)

    this_week = weeks.get(week_start_iso, {})
    current = get_week_groceries(week_start_iso, with_prices=False)
    on_list = {"i:" + i["ingredient_id"] for i in current} | {"t:" + i["name"].lower() for i in current}
    on_list |= {"t:" + _line_name(l["text"]).lower() for l in this_week.get("free_list", [])}
    on_list |= set(this_week.get("dismissed", []))

    out = []
    for key, st in stats.items():
        usual = st["got"] >= SUGGEST_MIN_WEEKS and st["score"] >= SUGGEST_MIN_SCORE
        if key in on_list or not (usual or key in last_week_got):
            continue
        if key.startswith("i:"):
            ing = ing_by_id[st["ingredient_id"]]
            name, shop_list = ing["name"], st.get("box") or aisles.list_for(ing)
        else:
            name, shop_list = st["text"], aisles.MARKET   # lines live on the market list
        out.append({"key": key, "name": name, "shop_list": shop_list,
                    "weeks": st["got"], "of": len(past), "score": round(st["score"], 3)})
    out.sort(key=lambda s: (-s["score"], s["name"].lower()))
    return out


def accept_suggestion(week_start_iso: str, key: str) -> None:
    if key.startswith("i:"):
        hit = next((s for s in suggestions(week_start_iso) if s["key"] == key), None)
        add_extra_item(week_start_iso, key[2:], shop_list=hit["shop_list"] if hit else None)
    elif key.startswith("t:"):
        hit = next((s for s in suggestions(week_start_iso) if s["key"] == key), None)
        add_free_item(week_start_iso, hit["name"] if hit else key[2:])
    else:
        raise KeyError(key)


def dismiss_suggestion(week_start_iso: str, key: str) -> None:
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    dismissed = week.setdefault("dismissed", [])
    if key not in dismissed:
        dismissed.append(key)
    _save(data)


def set_amount(week_start_iso: str, ingredient_id: str, text: str) -> list[dict]:
    """The amount typed on a list row, kept as typed ("2 lb", "1"). A hand-added
    item's amount simply becomes this; a meal-derived one shows it instead of
    the computed amount, for this week. Blank = no amount (a hand-add) or back
    to what the meals need (a meal-derived row)."""
    text = (text or "").strip()
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    extra = week.setdefault("extra_items", {}).get(ingredient_id)
    item = week.setdefault("items", {}).setdefault(ingredient_id, {})
    if extra is not None and ingredient_id not in week_ingredient_needs(week_start_iso):
        extra.update({"qty_g": 0.0, "qty_text": text})
        item.pop("qty_text", None)
    elif text:
        item["qty_text"] = text
    else:
        item.pop("qty_text", None)
    _save(data)
    return get_week_groceries(week_start_iso)


def swap_item(week_start_iso: str, old_id: str, new_id: str) -> list[dict]:
    """A hand-added row renamed to something else: the row becomes the new
    ingredient, keeping its amount, tick and list."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    extras, items = week.setdefault("extra_items", {}), week.setdefault("items", {})
    if old_id in extras and old_id != new_id:
        old = extras.pop(old_id)
        new = extras.setdefault(new_id, {"qty_g": 0.0})
        new["qty_g"] = new.get("qty_g", 0.0) + old.get("qty_g", 0.0)
        texts = [t for t in (new.get("qty_text"), old.get("qty_text")) if t]
        if texts:
            new["qty_text"] = " + ".join(texts)
        state = {k: v for k, v in items.pop(old_id, {}).items() if k != "removed_g"}
        items.setdefault(new_id, {}).update(state)
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


def add_free_item(week_start_iso: str, text: str, qty: str = "") -> list[dict]:
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    week.setdefault("free_list", []).append({
        "id": "f_" + uuid.uuid4().hex[:8], "text": text.strip(), "checked": False,
        **({"qty": qty.strip()} if qty and qty.strip() else {}),
    })
    _save(data)
    return week["free_list"]


def update_free_item(week_start_iso: str, item_id: str, fields: dict) -> list[dict]:
    data = _load()
    week = data["weeks"].get(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    item = next((i for i in week.get("free_list", []) if i["id"] == item_id), None)
    if item is None:
        raise KeyError(item_id)
    for key in ("text", "checked", "qty"):
        if key in fields and fields[key] is not None:
            item[key] = fields[key].strip() if key in ("text", "qty") else fields[key]
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
    return "\n".join(f"- {i['qty'] + ' ' if i.get('qty') else ''}{i['text']}" for i in items)


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


def set_package(week_start_iso: str, ingredient_id: str, package: Optional[dict]) -> None:
    """Buy this pack size this week instead of the store's usual match (stock.Ledger.bulk)."""
    data = _load()
    item = data["weeks"].setdefault(week_start_iso, {"items": {}})["items"].setdefault(ingredient_id, {})
    if package:
        item["package"] = {k: package.get(k) for k in ("package_g", "price", "label")}
    else:
        item.pop("package", None)
    _save(data)


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


# ── which week the list is for, and when it starts over ────────────────────
#
# Each list is for the week being shopped for, and the grocery list and the farmer's market list
# move on SEPARATELY: (a) every Monday, and (b) the moment that list's shop is done -- the Pixel
# records each visit to a grocery store or market near home (`trip-<ms>.json` beside the data,
# written by the Meals Android app on leaving, with its kind), and a visit counts as THE shop
# when at least half of THAT list was ticked off -- a quick top-up mid-week leaves it alone. Whatever was added by hand but not bought carries over to the new list;
# what the new week's meals need fills in by itself, and last week's buys come back as usuals.

TRIP_MIN_SHARE = 0.5
TRIP_MIN_CHECKED = 2


def _monday_target(day: datetime.date) -> datetime.date:
    """The week the list is for by the Monday rule: the shopping week after the last Monday."""
    last_monday = day - datetime.timedelta(days=day.weekday())
    reup = config.load()["reup_day"]
    return board.week_start_for(last_monday, reup) + datetime.timedelta(days=7)


def trips() -> list[dict]:
    out = []
    for p in sorted(DATA_DIR.glob("trip-*.json")):
        try:
            t = json.loads(p.read_text())
            out.append({"at": float(t["at"]) / 1000, **{k: t.get(k) for k in ("kind", "name", "dwell_s")}})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return sorted(out, key=lambda t: t["at"])


def _shopped(week_start_iso: str, kind: str) -> bool:
    """Was this week's grocery (or market) list mostly ticked off?"""
    rows = [i["checked"] for i in get_week_groceries(week_start_iso, with_prices=False)
            if (i["shop_list"] == aisles.MARKET) == (kind == aisles.MARKET) and not i.get("covered")]
    if kind == aisles.MARKET:
        rows += [bool(i.get("checked")) for i in list_free_items(week_start_iso)]
    done = sum(rows)
    return bool(rows) and done >= TRIP_MIN_CHECKED and done / len(rows) >= TRIP_MIN_SHARE


def list_week(today: Optional[datetime.date] = None, kind: str = aisles.GROCERY) -> str:
    """The week the grocery (or market) list is for right now (see above), carrying that
    list's unbought hand-adds forward whenever it moves on."""
    today = today or datetime.date.today()
    moved = datetime.date.min          # how far counted shops have pushed this list
    for t in trips():
        when = datetime.datetime.fromtimestamp(t["at"]).date()
        if when > today or (t.get("kind") or aisles.GROCERY) != kind:
            continue
        current = max(_monday_target(when), moved)     # the list on screen at that trip
        if _shopped(current.isoformat(), kind):
            moved = current + datetime.timedelta(days=7)
    week = max(_monday_target(today), moved).isoformat()
    _carry_forward(week, kind)
    return week


def _carry_forward(week_start_iso: str, kind: str = aisles.GROCERY) -> None:
    """Unbought hand-adds (and, for the market, its lines) from this list's previous week, once."""
    prev = (datetime.date.fromisoformat(week_start_iso) - datetime.timedelta(days=7)).isoformat()
    data = _load()
    old = data["weeks"].get(prev)
    new = data["weeks"].setdefault(week_start_iso, {"items": {}, "extra_items": {}, "free_list": []})
    mark = "carried_from" if kind == aisles.GROCERY else "carried_from_market"
    if not old or new.get(mark) == prev:
        return
    old_items = old.get("items", {})
    ing_by_id = ingredients.by_id()
    for ing_id, ex in old.get("extra_items", {}).items():
        st = old_items.get(ing_id, {})
        ing = ing_by_id.get(ing_id)
        on = st.get("shop_list") or (aisles.list_for(ing) if ing else aisles.GROCERY)
        if on != kind:
            continue
        if st.get("checked") or st.get("removed_g") is not None or ing_id in new.setdefault("extra_items", {}):
            continue
        new["extra_items"][ing_id] = dict(ex)
        if st.get("shop_list"):
            new.setdefault("items", {}).setdefault(ing_id, {})["shop_list"] = st["shop_list"]
    if kind == aisles.MARKET:
        have = {l["text"].lower() for l in new.setdefault("free_list", [])}
        for line in old.get("free_list", []):
            if not line.get("checked") and line["text"].lower() not in have:
                new["free_list"].append({**line, "id": "f_" + uuid.uuid4().hex[:8]})
    new[mark] = prev
    _save(data)


def geofences(lat: Optional[float] = None, lon: Optional[float] = None) -> list[dict]:
    """The PICKED grocery store and farmer's market of the active home, for the Pixel to watch --
    leaving one is a shopping trip. Only those two (Storm 2026-10-18: "only do my selected
    farmer's market and grocery store"); one not picked yet isn't watched. `lat`/`lon` are
    accepted for older pages and ignored -- the phone's position already picks the home
    (places.arrived)."""
    place = places.active()
    if not place:
        return []
    out, seen = [], set()
    for kind in ("grocery", "market"):
        picked = place.get("store" if kind == "grocery" else "market")
        shops = [picked] if picked else []
        for s in shops:
            if not s or s.get("lat") is None:
                continue
            key = (round(s["lat"], 5), round(s["lon"], 5))
            if key in seen:
                continue
            seen.add(key)
            out.append({"lat": s["lat"], "lon": s["lon"], "kind": kind, "name": s.get("name", "")})
    return out[:90]       # Android allows 100 proximity alerts per app


PRICE_BATCH = 6


def price_missing(week_start_iso: str, ingredient_ids: list[str]) -> int:
    """Live prices for these rows of the list that have none yet -- what the list asks for by
    itself after drawing (Storm 2026-10-18: "does it auto find the prices?"). A few at a time;
    a price already remembered and fresh isn't fetched again (prices.price_for), unless it was
    saved before its aisle was kept."""
    want = set(ingredient_ids[:PRICE_BATCH])
    shops = {"grocery": active_shop("grocery"), "market": active_shop("market")}
    ing_by_id = ingredients.by_id()
    found = 0
    for row in get_week_groceries(week_start_iso, with_prices=True, allow_network=False):
        if row["ingredient_id"] not in want or (row.get("price") is not None and row.get("aisle_known", True)):
            continue
        ing = ing_by_id.get(row["ingredient_id"])
        if ing and prices.price_for(ing, shops[row["shop_list"]], allow_network=True):
            found += 1
    return found
