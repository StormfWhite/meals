"""Keeping the ingredient catalog clean: where an ingredient is used, merging a copy into
the real one ("makgo" into "mango"), and forgetting one offered by mistake.

Every data file that can hold an ingredient id is walked as plain JSON -- recipes, the
board (meal lines and overrides), the lists, prices, stock, bangers, routines -- so a new
place an id is kept doesn't need a new rule here, only its file in `_files`.
"""
from __future__ import annotations

import datetime
from typing import Any

from . import (bangers, board, groceries, ingredients, learning, prices, recipes, routines,
               stock, store)


def _files() -> list:
    # read at call time: the tests point each module at its own copy
    return [recipes.RECIPES_FILE, board.BOARD_FILE, groceries.GROCERIES_FILE,
            groceries.PRICE_HISTORY_FILE, prices.PRICES_FILE, stock.STOCK_FILE,
            learning.LEARNING_FILE, routines.ROUTINES_FILE, bangers.BANGERS_FILE]


def _mentions(node: Any, ing_id: str) -> bool:
    if isinstance(node, dict):
        return any(k == ing_id or k == "i:" + ing_id or _mentions(v, ing_id) for k, v in node.items())
    if isinstance(node, list):
        return any(_mentions(v, ing_id) for v in node)
    return node == ing_id or node == "i:" + ing_id


def used(ing_id: str) -> bool:
    """Anything at all still points at it -- a meal, a list, a price, the pantry."""
    return any(path.exists() and _mentions(store.load(path, {}), ing_id) for path in _files())


def _swap(node: Any, src: str, dst: str) -> Any:
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            key = dst if k == src else "i:" + dst if k == "i:" + src else k
            v = _swap(v, src, dst)
            if key in out and key != k:          # both had an entry: the real one's stays
                continue
            out[key] = v
        return out
    if isinstance(node, list):
        return [_swap(v, src, dst) for v in node]
    if node == src:
        return dst
    if node == "i:" + src:
        return "i:" + dst
    return node


def merge(src: str, dst: str) -> dict:
    """Every use of `src` becomes `dst`, then `src` is gone."""
    if src == dst or ingredients.get(src) is None or ingredients.get(dst) is None:
        raise KeyError(src if ingredients.get(src) is None else dst)
    for path in _files():
        if path.exists():
            data = store.load(path, {})
            if _mentions(data, src):
                store.save(path, _swap(data, src, dst))
    ingredients.delete(src)
    return ingredients.get(dst)


def forget(ing_id: str) -> dict:
    """The × on a suggestion. Never used anywhere (a typo, a half-typed line): deleted.
    Used before: kept for those meals, just not offered any more -- until it's used again."""
    if not used(ing_id):
        ingredients.delete(ing_id)
        return {"deleted": True}
    ingredients.update(ing_id, hide_suggest=datetime.date.today().isoformat())
    return {"deleted": False}
