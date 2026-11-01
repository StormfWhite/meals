"""Which list an ingredient belongs on: the farmer's market, or the store.

Every ingredient written into a meal has to end up on one of the two
shopping lists -- that's the whole point of the plan feeding the lists.
The only question is which one, and the answer is mostly "is this a fresh
thing a farm stand sells".

The rule, in the order it's applied:

  1. an explicit choice the user made (`shop_list_locked`) always wins and
     is never re-derived -- moving lettuce to the store list once must not
     be undone the next time the catalog is touched
  2. a preserved form goes to the store no matter what it started as:
     frozen peas, canned tomatoes and tomato paste are aisle items even
     though "tomato" is farm produce
  3. fresh herbs go to the market (basil, cilantro, parsley, mint...): USDA files them under
     "Spices and Herbs", which would otherwise read as an aisle item. Dried/ground ones are
     caught by rule 2 first
  3b. what was learned from moves (see `learn`): moving an item sets a rule for its words, the
     latest move winning, so the next new thing with that word goes where the last one went
  4a. an aisle staple goes to the store: garlic, lemons and ginger are
     produce that in practice comes from the same shop as the pasta, and
     a market list that keeps demanding one clove of garlic is noise
  4. anything left in a fresh produce category goes to the market
  5. everything else goes to the store

Category comes from the USDA match when there is one (see fdc.py's
`food_category`), so a newly typed "zucchini" lands on the market list
without anyone tagging it -- which is exactly why binding ingredients to
real USDA foods is worth doing on creation rather than lazily.
"""
from __future__ import annotations

import re
import time

from . import store
from .paths import DATA_DIR

RULES_FILE = DATA_DIR / "aisle_rules.json"

GROCERY = "grocery"
MARKET = "market"

FRESH_CATEGORIES = {"vegetable", "fruit"}

# A form the market doesn't sell: it's been processed for the shelf.
# Matched as whole words so "freshly ground pepper" isn't read as
# "ground" the preserved form... it is, actually, and that's correct --
# ground pepper is an aisle item.
PRESERVED_MARKERS = {
    "frozen", "canned", "can", "jarred", "jar", "pickled", "dried", "dry",
    "powder", "powdered", "paste", "puree", "sauce", "juice", "concentrate",
    "extract", "oil", "vinegar", "syrup", "flour", "ground", "roasted",
    "smoked", "cured", "instant", "boxed", "bottled", "packet", "mix",
}

# Produce you buy in the aisle, all year, from the same shop as everything
# else. Storm's own examples (garlic, a lemon) plus the rest of the
# aromatics-and-tropicals that no local farm stand is growing.
AISLE_PRODUCE = {
    "garlic", "ginger", "lemon", "lemons", "lime", "limes", "banana",
    "bananas", "avocado", "avocados", "pineapple", "mango", "mangoes",
    "coconut", "lemongrass", "turmeric", "olive", "olives", "date", "dates",
    "raisin", "raisins", "shallot", "shallots",
}

# Last-resort categoriser for when there's no USDA match to read a category
# off -- a short keyword table, not a taxonomy. Only used to decide the
# list, never to overwrite a category that USDA already answered.
_FRESH_WORDS = {
    "lettuce", "spinach", "kale", "arugula", "chard", "collard", "cabbage",
    "broccoli", "cauliflower", "carrot", "carrots", "celery", "cucumber",
    "zucchini", "squash", "pumpkin", "eggplant", "pepper", "peppers",
    "tomato", "tomatoes", "potato", "potatoes", "sweet potato", "yam",
    "onion", "onions", "leek", "leeks", "scallion", "radish", "beet",
    "beets", "turnip", "asparagus", "green bean", "green beans", "pea",
    "peas", "corn", "okra", "mushroom", "mushrooms", "herb", "basil",
    "cilantro", "parsley", "mint", "rosemary", "thyme", "sage", "dill",
    "apple", "apples", "pear", "pears", "peach", "peaches", "plum",
    "berry", "berries", "strawberry", "strawberries", "blueberry",
    "blueberries", "raspberry", "blackberry", "melon", "watermelon",
    "cantaloupe", "grape", "grapes", "cherry", "cherries", "fig", "figs",
    "apricot", "nectarine", "persimmon", "rhubarb", "sprouts",
}


FRESH_HERBS = {"basil", "cilantro", "parsley", "mint", "rosemary", "thyme", "sage", "dill", "chives",
               "tarragon", "chervil", "marjoram", "herb", "herbs", "lemongrass", "microgreens"}
# words too generic to carry a learned rule ("fresh", "organic", sizes...)
_RULE_SKIP = {"fresh", "organic", "raw", "large", "small", "medium", "big", "whole", "baby", "the", "of",
              "and", "with", "or", "a", "cut", "chopped", "sliced", "diced", "minced"}


def _rule_words(name: str) -> set[str]:
    return {w for w in _words(name) if len(w) > 2 and w not in _RULE_SKIP and w not in PRESERVED_MARKERS}


def _rules() -> dict:
    return store.load(RULES_FILE, {})


def learn(name: str, where: str) -> None:
    """A move by hand becomes a rule for the future: every meaningful word of the name now
    points at `where` (the latest move wins, so it defaults to where it went last). Preserved
    forms ("dried mango") teach nothing -- they always go to the store."""
    if where not in (GROCERY, MARKET) or _words(name) & PRESERVED_MARKERS:
        return
    words = _rule_words(name)
    if not words:
        return
    rules, now = _rules(), time.time()
    for w in words:
        rules[w] = {"list": where, "at": now}
    store.save(RULES_FILE, rules)


def learned(name: str) -> str | None:
    """What the moves so far say about this name, if anything: the most recent matching word."""
    rules = _rules()
    hits = [rules[w] for w in _rule_words(name) if w in rules]
    return max(hits, key=lambda r: r["at"])["list"] if hits else None


def _words(name: str) -> set[str]:
    return {w for w in re.split(r"[^a-z]+", (name or "").lower()) if w}


def looks_fresh(name: str) -> bool:
    """Fresh produce by name alone, for ingredients with no USDA category."""
    lowered = (name or "").lower()
    if any(phrase in lowered for phrase in ("sweet potato", "green bean")):
        return True
    return bool(_words(name) & _FRESH_WORDS)


def classify(name: str, category: str = "other") -> str:
    """The list this ingredient belongs on, ignoring any user override --
    callers that respect the override should use `list_for` instead."""
    words = _words(name)
    if words & PRESERVED_MARKERS:
        return GROCERY
    seen = learned(name)
    if seen:
        return seen
    if words & FRESH_HERBS:
        return MARKET
    if words & AISLE_PRODUCE:
        return GROCERY
    if category in FRESH_CATEGORIES:
        return MARKET
    if category == "other" and looks_fresh(name):
        return MARKET
    return GROCERY


def list_for(ingredient: dict) -> str:
    """The list this ingredient is actually on: the user's choice if they
    ever made one, otherwise the derived answer. Stored `shop_list` values
    are trusted even when unlocked so the catalog reads consistently
    without re-deriving on every request."""
    if ingredient.get("shop_list") in (GROCERY, MARKET):
        return ingredient["shop_list"]
    return classify(ingredient.get("name", ""), ingredient.get("category", "other"))
