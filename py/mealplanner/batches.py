"""Cooked meals put away: a batch made in bulk, its spare servings in the fridge or the freezer.

Storm 2026-10-22: "a button at the bottom to click if we are making it in bulk how many servings
we are storing in the fridge or freezer", and later meals should say they're coming from there.

A slot can carry `store: {"n": 6, "where": "freezer"}` -- this cook makes 6 servings beyond the
meal itself, put away. Its ingredient lines are what goes in the pot, so the grocery list buys
for the whole batch; nothing is scaled behind anyone's back. A later slot with the SAME recipe
then eats from what's put away (its `servings_used`, fridge first, oldest first) instead of
cooking: it's "served", and its ingredients are needed nowhere (groceries, stock). `fresh: true`
on a slot says "cook it fresh anyway".

Like stock.py, nothing here is logged: the shelf is REPLAYED over every saved week in cooking
order (date, breakfast/lunch/dinner, slot index). Fridge servings keep FRIDGE_DAYS, freezer ones
FREEZER_DAYS. The only stored thing is a correction ("2 left" / "gone"), in stock.json under
"meals", which sets that recipe's servings in that place as of a date.
"""
from __future__ import annotations

import datetime
import time
from typing import Optional

from . import board, routines, store

FRIDGE_DAYS = 4
FREEZER_DAYS = 90
PLACES = ("fridge", "freezer")
_MEAL_RANK = {m: i for i, m in enumerate(board.MEALS)}


def _stock_file():
    from . import stock          # stock.py imports groceries, which imports this
    return stock.STOCK_FILE


def _days(a: str, b: str) -> int:
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days


def _sig() -> tuple:
    out = []
    for p in (board.BOARD_FILE, routines.ROUTINES_FILE, _stock_file()):
        try:
            st = p.stat()
            out.append((str(p), st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((str(p), None, None))
    return tuple(out)


_cache: dict = {}


def shelf() -> "Shelf":
    """One replay per change of the plan or the corrections (the list redraw asks many times)."""
    sig = _sig()
    if _cache.get("sig") != sig:
        _cache["sig"], _cache["shelf"] = sig, Shelf()
    return _cache["shelf"]


def _slots() -> list[tuple]:
    out = []
    for week_start in board._load()["weeks"]:
        for key, slot in board.get_week(week_start)["slots"].items():
            date, meal, index = board.parse_slot_key(key)
            out.append((date, _MEAL_RANK.get(meal, 9), index, week_start, key, slot))
    out.sort(key=lambda t: t[:3])
    return out


class Shelf:
    def __init__(self):
        self.slots = _slots()
        self.corrections = sorted(store.load(_stock_file(), {}).get("meals", []),
                                  key=lambda c: (c["date"], c.get("at", 0)))
        self.served: dict[tuple[str, str], dict] = {}     # (week, key) -> where it came from
        self.made: dict[tuple[str, str], dict] = {}       # (week, key) -> what of that batch is left
        self._run()

    def _run(self, until: Optional[str] = None) -> dict[str, list[dict]]:
        """Walk the plan; `until` stops before the first slot on/after that date and returns
        what's put away at that moment (recipe_id -> lots)."""
        lots: dict[str, list[dict]] = {}
        fixes = list(self.corrections)
        for date, _, _, week, key, slot in self.slots:
            if until and date >= until:
                break
            while fixes and fixes[0]["date"] <= date:
                _apply(lots, fixes.pop(0))
            _expire(lots, date)
            rid, need = slot.get("recipe_id"), float(slot.get("servings_used") or 1)
            st = slot.get("store") or {}
            if st.get("n"):
                lot = {"n": float(st["n"]), "where": st.get("where") or "freezer", "made": date,
                       "key": key, "week": week}
                lots.setdefault(rid, []).append(lot)
                if not until:
                    self.made[(week, key)] = lot
                continue
            if slot.get("fresh") or slot.get("leftover_group"):
                continue
            have = sorted(lots.get(rid, []), key=lambda l: (l["where"] != "fridge", l["made"]))
            if sum(l["n"] for l in have) + 1e-6 < need:
                continue
            first = have[0]
            for lot in have:
                take = min(lot["n"], need)
                lot["n"] -= take
                need -= take
                if need <= 1e-6:
                    break
            lots[rid] = [l for l in have if l["n"] > 1e-6]
            if not until:
                self.served[(week, key)] = {"where": first["where"], "made": first["made"],
                                            "from_key": first["key"], "from_week": first.get("week"),
                                            "left": round(sum(l["n"] for l in lots[rid]), 2)}
        if until:
            while fixes and fixes[0]["date"] <= until:
                _apply(lots, fixes.pop(0))
            _expire(lots, until)
        return lots

    def served_in(self, week: str) -> dict[str, dict]:
        return {k: v for (w, k), v in self.served.items() if w == week}

    def made_in(self, week: str) -> dict[str, dict]:
        """Batches cooked this week, with how many of their servings are still put away at the end."""
        return {k: v for (w, k), v in self.made.items() if w == week}

    def put_away(self, date: str) -> list[dict]:
        """What's in the fridge and freezer the morning of `date`, one row per recipe and place."""
        out = []
        for rid, lots in self._run(until=date).items():
            for where in PLACES:
                mine = [l for l in lots if l["where"] == where and l["n"] > 1e-6]
                if not mine:
                    continue
                oldest = min(l["made"] for l in mine)
                keep = FRIDGE_DAYS if where == "fridge" else FREEZER_DAYS
                out.append({"recipe_id": rid, "where": where, "n": round(sum(l["n"] for l in mine), 2),
                            "made": oldest, "use_by": (datetime.date.fromisoformat(oldest)
                                                       + datetime.timedelta(days=keep)).isoformat()})
        return out


def _apply(lots: dict, fix: dict) -> None:
    rid, where, n = fix["recipe_id"], fix["where"], float(fix["n"])
    mine = sorted((l for l in lots.get(rid, []) if l["where"] == where), key=lambda l: l["made"])
    have = sum(l["n"] for l in mine)
    if n < have:                                     # some were eaten or thrown out: oldest first
        gone = have - n
        for lot in mine:
            take = min(lot["n"], gone)
            lot["n"] -= take
            gone -= take
    elif n > have:
        lots.setdefault(rid, []).append({"n": n - have, "where": where, "made": fix["date"], "key": None, "week": None})
    if rid in lots:
        lots[rid] = [l for l in lots[rid] if l["n"] > 1e-6]


def _expire(lots: dict, date: str) -> None:
    for rid in list(lots):
        lots[rid] = [l for l in lots[rid]
                     if _days(l["made"], date) <= (FRIDGE_DAYS if l["where"] == "fridge" else FREEZER_DAYS)]
        if not lots[rid]:
            lots.pop(rid)


def add(recipe_id: str, where: str, n: float, date: str) -> None:
    """Meal blocks put away by hand (the Pantry's add box): on top of what's already there."""
    have = sum(m["n"] for m in shelf().put_away(date) if m["recipe_id"] == recipe_id and m["where"] == where)
    correct(recipe_id, where, have + n, date)


def correct(recipe_id: str, where: str, n: float, date: str) -> None:
    """"There are actually n servings of it in the fridge/freezer" from `date` on (0 = gone)."""
    if where not in PLACES:
        raise ValueError("fridge or freezer")
    data = store.load(_stock_file(), {"corrections": []})
    keep = [c for c in data.get("meals", [])
            if not (c["recipe_id"] == recipe_id and c["where"] == where and c["date"] == date)]
    keep.append({"recipe_id": recipe_id, "where": where, "n": max(0.0, float(n)), "date": date, "at": time.time()})
    data["meals"] = keep
    store.save(_stock_file(), data)
