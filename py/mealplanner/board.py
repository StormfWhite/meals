"""The weekly schedule: which recipe sits in which day/meal slot.

A week is keyed by its start date (ISO, the most recent occurrence of the
configured re-up day on or before "today"), so the Board always opens on
the week that's actually current for whenever the app is launched, not a
fixed Monday. Slots are keyed "<date>:<breakfast|lunch|dinner>".

Leftover linking is an explicit user action (see plan/board.js), not an
automatic side effect of reusing a recipe -- the same breakfast recipe
showing up five days running isn't leftovers, it's a routine. A
leftover_group only forms when the frontend calls link_slots for two
slots that already share a recipe_id.

**One meal slot can hold several meals.** Breakfast is a smoothie *and*
fried eggs often enough that forcing a choice is wrong. Extra meals at
the same slot get an indexed key -- "2026-08-17:breakfast~2" -- so every
existing key still means what it always meant and nothing had to be
migrated. Split keys with `parse_slot_key`, never `key.split(":")`, or
the meal reads as "breakfast~2" and drops out of every by-meal filter.

The separator is "~" and that matters: a slot key travels in a URL path
(`/api/board/{week}/slots/{slot_key}`), and "#" -- the obvious choice --
is a fragment delimiter that never reaches the server at all. Measured:
a second breakfast saved under a "#" key silently overwrote the first.
"~" is unreserved in RFC 3986, so it needs no escaping anywhere.

Repeating meals (routines.py) are materialised here on read rather than
written into future weeks; a stored slot at the same date+meal always
wins, and a `{"cleared": True}` tombstone is how "not this week" is
recorded against a rule that would otherwise refill it.
"""
from __future__ import annotations

import datetime
import uuid
from typing import Optional

from . import config, ingredients, recipes, routines, store
from .paths import BOARD_FILE

WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
MEALS = ("breakfast", "lunch", "dinner")


SLOT_INDEX_SEP = "~"


def slot_key(date_iso: str, meal: str, index: int = 0) -> str:
    """Index 0 keeps the original "<date>:<meal>" form on purpose: it's
    what every week already saved on disk uses."""
    return f"{date_iso}:{meal}" if index == 0 else f"{date_iso}:{meal}{SLOT_INDEX_SEP}{index}"


def servings(slot: dict) -> float:
    try:
        n = float(slot.get("servings_used") or 1)
    except (TypeError, ValueError):
        return 1.0
    return n if n > 0 else 1.0


def parse_slot_key(key: str) -> tuple[str, str, int]:
    date, _, rest = key.partition(":")
    meal, _, index = rest.partition(SLOT_INDEX_SEP)
    return date, meal, int(index) if index.isdigit() else 0


def _load() -> dict:
    return store.load(BOARD_FILE, {"weeks": {}})


def _save(data: dict) -> None:
    store.save(BOARD_FILE, data)


def week_start_for(date: datetime.date, reup_day: str) -> datetime.date:
    target = WEEKDAYS.index(reup_day) if reup_day in WEEKDAYS else 6  # default sunday
    delta = (date.weekday() - target) % 7
    return date - datetime.timedelta(days=delta)


def current_week_start() -> str:
    reup_day = config.load()["reup_day"]
    return week_start_for(datetime.date.today(), reup_day).isoformat()


def week_dates(week_start_iso: str) -> list[str]:
    start = datetime.date.fromisoformat(week_start_iso)
    return [(start + datetime.timedelta(days=i)).isoformat() for i in range(7)]


def _empty_week() -> dict:
    return {"slots": {}, "leftover_groups": {}}


def _is_tombstone(slot: dict) -> bool:
    return bool(slot.get("cleared"))


def _routine_slots(dates: list[str], stored: dict) -> dict:
    """The repeating meals that land in this week.

    A routine claims the *base* key for its day and meal, and stands aside
    only when that exact key already holds something -- a meal planned
    over the top of it, or a `cleared` tombstone meaning "not this week".
    Deliberately not "anything at this date+meal": adding fried eggs
    alongside the smoothie you have every morning must not delete the
    smoothie, and that second meal lives at an indexed key.
    """
    out: dict = {}
    for date in dates:
        for routine in routines.for_date(date):
            if slot_key(date, routine["meal"]) in stored:
                continue
            out[slot_key(date, routine["meal"])] = {
                "recipe_id": routine["recipe_id"],
                "servings_used": routine.get("servings_used", 1),
                "leftover_group": None,
                "ingredient_overrides": routine.get("ingredient_overrides"),
                "from_routine": routine["id"],
            }
    return out


def get_week(week_start_iso: str) -> dict:
    data = _load()
    week = data["weeks"].get(week_start_iso, _empty_week())
    dates = week_dates(week_start_iso)
    # Tombstones are storage, not schedule: they exist to stop a routine
    # refilling a slot, and every reader downstream (groceries, nutrition,
    # diversity) would trip over a slot with no recipe_id.
    slots = {k: v for k, v in week["slots"].items() if not _is_tombstone(v)}
    slots = {**_routine_slots(dates, week["slots"]), **slots}
    return {"week_start": week_start_iso, "dates": dates,
            "slots": slots, "leftover_groups": week["leftover_groups"]}


def next_slot_index(week_start_iso: str, date_iso: str, meal: str) -> int:
    """The index a new meal added alongside an existing one should take."""
    used = {i for d, m, i in (parse_slot_key(k) for k in get_week(week_start_iso)["slots"])
            if d == date_iso and m == meal}
    index = 0
    while index in used:
        index += 1
    return index


def set_slot(week_start_iso: str, slot_key: str, recipe_id: str, servings_used: float,
             ingredient_overrides: Optional[list] = None) -> dict:
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, _empty_week())
    existing = week["slots"].get(slot_key, {})
    same = existing.get("recipe_id") == recipe_id
    week["slots"][slot_key] = {
        "recipe_id": recipe_id,
        "servings_used": servings_used,
        "leftover_group": existing.get("leftover_group") if same else None,
        "ingredient_overrides": ingredient_overrides,
    }
    # a batch put away / "cook it fresh" (batches.py) belongs to this meal, not to the slot
    for key in ("store", "fresh"):
        if same and existing.get(key):
            week["slots"][slot_key][key] = existing[key]
    # who eats it belongs to the slot ("Joanna's extra lunch"), whatever goes in it
    if existing.get("eaters"):
        week["slots"][slot_key]["eaters"] = existing["eaters"]
    _prune_leftover_groups(week)
    _save(data)
    return get_week(week_start_iso)


def set_slot_extra(week_start_iso: str, key: str, **fields) -> dict:
    """`store` ({"n", "where"} or None) and `fresh` (bool) on a planned slot -- see batches.py --
    and `eaters` (member ids; none = the whole household, household.portion).
    A routine's slot is written down first, so the extra has somewhere to live."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, _empty_week())
    slot = week["slots"].get(key)
    if slot is None or _is_tombstone(slot):
        live = get_week(week_start_iso)["slots"].get(key)
        if live is None:
            raise KeyError(key)
        slot = week["slots"][key] = {k: v for k, v in live.items() if k != "from_routine"}
    for name, value in fields.items():
        if value:
            slot[name] = value
        else:
            slot.pop(name, None)
    _save(data)
    return get_week(week_start_iso)


def clear_slot(week_start_iso: str, key: str) -> dict:
    """Empty one slot. If a routine would immediately put the meal back,
    a tombstone is written instead of a plain delete -- otherwise "not
    this Monday" would be undone by the next page load."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, _empty_week())
    stored = week["slots"].pop(key, None)
    date, meal, _ = parse_slot_key(key)
    would_return = any(r["meal"] == meal for r in routines.for_date(date))
    if stored is None and not would_return:
        raise KeyError(key)
    if would_return:
        week["slots"][key] = {"cleared": True}
    _prune_leftover_groups(week)
    _save(data)
    return get_week(week_start_iso)


def link_slots(week_start_iso: str, slot_a: str, slot_b: str) -> dict:
    """Join two slots into one leftover group. Both must already hold the
    same recipe -- linking is how you say "this is the same batch", not
    how you assign a recipe in the first place."""
    data = _load()
    week = data["weeks"].setdefault(week_start_iso, _empty_week())
    a, b = week["slots"].get(slot_a), week["slots"].get(slot_b)
    if a is None or b is None:
        raise KeyError("both slots must be assigned before linking")
    if a["recipe_id"] != b["recipe_id"]:
        raise ValueError("linked slots must share the same recipe")

    group_id = a.get("leftover_group") or b.get("leftover_group") or ("lg_" + uuid.uuid4().hex[:8])
    recipe = recipes.get(a["recipe_id"])
    week["leftover_groups"][group_id] = {
        "recipe_id": a["recipe_id"],
        "total_servings": recipe["servings"] if recipe else None,
    }
    a["leftover_group"] = group_id
    b["leftover_group"] = group_id
    _save(data)
    return get_week(week_start_iso)


def week_diversity(week_start_iso: str) -> dict:
    """Distinct ingredients used this week, grouped by category -- presence
    only, so a leftover batch spanning several slots still counts its
    ingredients once each (a set can't double-count a member)."""
    week = get_week(week_start_iso)
    ing_by_id = ingredients.by_id()
    seen: dict[str, set] = {}

    for slot in week["slots"].values():
        recipe = recipes.get(slot["recipe_id"])
        if recipe is None:
            continue
        ing_list = slot.get("ingredient_overrides") or recipe["ingredients"]
        for item in ing_list:
            ing = ing_by_id.get(item["ingredient_id"])
            if ing is None:
                continue
            seen.setdefault(ing.get("category", "other"), set()).add(ing["id"])

    categories = {cat: sorted(ing_by_id[i]["name"] for i in ids) for cat, ids in seen.items()}
    counts = {cat: len(ids) for cat, ids in seen.items()}
    return {"counts": counts, "categories": categories}


def all_slots_history() -> list[dict]:
    """Every slot ever scheduled, across every saved week, flattened to one
    record per slot with its date/meal pulled out of the slot key. Raw
    material for meal_options() and stats.py -- no new storage, just a scan
    over what's already in board.json.

    Routines are folded in as one current entry each. They're never written
    to a week, so without this the meal you eat every single Monday would
    be invisible to the suggestion ranking and to the "past meals at this
    slot" list -- the two places it should rank highest."""
    data = _load()
    today = datetime.date.today().isoformat()
    out = []
    for week_start, week in data["weeks"].items():
        for key, slot in week["slots"].items():
            if _is_tombstone(slot):
                continue
            date, meal, index = parse_slot_key(key)
            out.append({"date": date, "meal": meal, "index": index,
                        "week_start": week_start, **slot})
    for routine in routines.list_routines():
        if not routine.get("active", True):
            continue
        out.append({"date": today, "meal": routine["meal"], "index": 0,
                    "week_start": current_week_start(),
                    "recipe_id": routine["recipe_id"],
                    "servings_used": routine.get("servings_used", 1),
                    "ingredient_overrides": routine.get("ingredient_overrides"),
                    "from_routine": routine["id"]})
    return out


def meal_options(meal: str) -> list[dict]:
    """Recipes that have ever been scheduled at this meal type, best first --
    the source list for "click an old breakfast item" instead of requiring
    recipes to be tagged by meal type up front.

    Order is one score blending both asks: every past use counts, but a use
    fades with age (half-life 30 days), so a meal eaten often AND lately
    beats one eaten often long ago or once yesterday. Ties go to the more
    recent. Recipes the user removed from the dropdown are skipped (the
    recipe itself, and the history, are untouched)."""
    today = datetime.date.today()
    by_recipe: dict[str, dict] = {}
    for slot in all_slots_history():
        if slot["meal"] != meal:
            continue
        entry = by_recipe.setdefault(slot["recipe_id"], {"recipe_id": slot["recipe_id"], "count": 0,
                                                         "last_date": slot["date"], "score": 0.0})
        entry["count"] += 1
        try:
            age = max(0, (today - datetime.date.fromisoformat(slot["date"])).days)
        except ValueError:
            age = 0
        entry["score"] += 0.5 ** (age / 30.0)
        if slot["date"] > entry["last_date"]:
            entry["last_date"] = slot["date"]
    return sorted(by_recipe.values(), key=lambda r: (r["score"], r["last_date"]), reverse=True)


def day_slots(date_iso: str) -> dict:
    """Just one date's three meal slots, without the caller needing to
    replicate the reup-day weekday math to find which week it lives in.

    `next_week_start` rides along because the shopping list beside the plan
    is always the *coming* week's, never the one being lived through -- on
    Saturday you shop for the week that starts tomorrow, and the frontend
    shouldn't have to know the re-up day to work that out."""
    reup_day = config.load()["reup_day"]
    start = week_start_for(datetime.date.fromisoformat(date_iso), reup_day)
    week_start = start.isoformat()
    week = get_week(week_start)
    slots: dict[str, list] = {meal: [] for meal in MEALS}
    for key, slot in week["slots"].items():
        date, meal, index = parse_slot_key(key)
        if date != date_iso or meal not in slots:
            continue
        slots[meal].append({"key": key, "index": index, **slot})
    for meal in slots:
        slots[meal].sort(key=lambda s: s["index"])
    return {"date": date_iso, "week_start": week_start, "slots": slots,
            "next_week_start": (start + datetime.timedelta(days=7)).isoformat()}


def _prune_leftover_groups(week: dict) -> None:
    """A group with fewer than 2 members isn't a link anymore -- drop it so
    the badge disappears rather than showing a "leftover" tag on a single
    cell with nothing to connect to."""
    counts: dict[str, int] = {}
    for slot in week["slots"].values():
        gid = slot.get("leftover_group")
        if gid:
            counts[gid] = counts.get(gid, 0) + 1
    dead = {gid for gid, n in counts.items() if n < 2}
    dead |= set(week["leftover_groups"]) - set(counts)
    for slot in week["slots"].values():
        if slot.get("leftover_group") in dead:
            slot["leftover_group"] = None
    for gid in dead:
        week["leftover_groups"].pop(gid, None)
