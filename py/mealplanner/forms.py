"""What an ingredient comes from (Storm 2026-10-26: "it should know things like cloves come from
1 head of garlic … or caramelized onions come from yellow onions").

Two kinds, both a fixed table here -- kitchen facts, not a guess:

- The SAME food, said another way: "garlic cloves", "minced garlic", "diced onion". There is no
  separate ingredient: `ingredients.add` hands back the base, so there is one Garlic in the
  meals, on the list, in the Pantry and in the nutrition.
- MADE FROM another: "caramelized onions" are yellow onions cooked down to a quarter of their
  weight, a cup of cooked rice is a third of a cup of dry. The ingredient keeps its own name and
  gets `from = {"id": base, "per_g": grams of base per gram of it}`. The list buys the base
  (groceries.week_ingredient_needs). Its nutrition is its own USDA record when it has one
  ("Lemon juice, raw"), else the base's per gram × per_g -- the same food with water gone or
  taken up.
"""
from __future__ import annotations

import re
from typing import Optional

# how it gets prepared on the way into the pot -- the food is the same
_PREP = r"(?:freshly |finely |coarsely |thinly |roughly )?(?:diced|chopped|minced|sliced|cubed|grated|" \
        r"shredded|crushed|peeled|julienned|halved|quartered|trimmed|torn)"
# ...except where the prepared one is its own product: a can of crushed tomatoes, a jar of
# crushed red pepper, desiccated coconut
_PRODUCT = re.compile(r"\b(tomato(?:es)?|red pepper|pepper flakes|coconut|wheat)\b", re.I)

# typed name -> (base name, grams of base per gram, conversions of its own). per_g from a
# cook's yield: 3 lb onions caramelize to ~1.5 cups (~210 g a cup); a cup of dry white rice
# (185 g) cooks to 3 cups (~158 g each); lentils 192 g dry -> 2.5 cups (~198 g); quinoa 170 g ->
# 3 cups (~185 g); dry pasta about doubles and a bit; a lemon (~100 g) gives 3 tbsp juice,
# a lime (~67 g) 2 tbsp; one large egg = 33 g white + 17 g yolk.
MADE_FROM = [
    (r"\bcarameli[sz]ed (?:(yellow|sweet|red|white) )?onions?\b", r"\1 onions", 4.0, {"cup": 210.0}),
    (r"\b(?:sauteed|sautéed|fried) (?:(yellow|sweet|red|white) )?onions?\b", r"\1 onions", 1.6, {"cup": 150.0}),
    (r"\bcooked ((?:white |brown |jasmine |basmati )?rice)\b", r"\1", 0.37, {"cup": 158.0}),
    (r"\bcooked ((?:green |brown |red |black )?lentils)\b", r"\1", 0.39, {"cup": 198.0}),
    (r"\bcooked (quinoa)\b", r"\1", 0.31, {"cup": 185.0}),
    (r"\bcooked (pasta|spaghetti|penne|macaroni)\b", r"\1", 0.45, {"cup": 140.0}),
    (r"\b(lemon) juice\b", r"\1", 2.2, {}),
    (r"\b(lime) juice\b", r"\1", 2.2, {}),
    (r"\b(lemon|lime|orange) zest\b", r"\1", 16.0, {"tbsp": 6.0}),
    (r"\begg whites?\b", "egg", 1.5, {"each": 33.0}),
    (r"\begg yolks?\b", "egg", 3.0, {"each": 17.0}),
]
# a juice or a white is its own food in USDA; a cooked-down or cooked-up pot is the base re-weighed
OWN_NUTRITION = re.compile(r"\b(juice|zest|whites?|yolks?)\b", re.I)

# what the base is bought as: garlic by the head (~12 cloves)
BUY_AS = {"garlic": ("head", "clove", 12)}


def _spell(name: str) -> str:
    from . import ingredients
    name = name.strip().lower()
    for typed, usda in ingredients._SPELLINGS.items():
        name = re.sub(rf"\b{typed}\b", usda, name)
    return name


def _cased(like: str, name: str) -> str:
    return name[:1].upper() + name[1:] if like[:1].isupper() else name


def same_food(name: str) -> Optional[str]:
    """The base a name is just another way of saying, or None. "Carlic cloves" -> "Garlic",
    "minced garlic" -> "garlic", "Onion, diced" -> "Onion". Never "cloves" alone (the spice),
    never a can of crushed tomatoes."""
    from . import ingredients
    n = _spell(name)
    if _PRODUCT.search(n):
        return None
    base = n
    base = re.sub(r"^(?:\d+ )?cloves? (?:of )?(garlic)$", r"\1", base)
    base = re.sub(r"^(garlic) cloves?$", r"\1", base)
    base = re.sub(rf"^{_PREP}(?: and {_PREP})?\s+", "", base)
    base = re.sub(rf",?\s+{_PREP}(?: and {_PREP})?$", "", base)
    base = re.sub(r"^(basil|mint|cilantro|parsley|sage|thyme|oregano|spinach) leaves$", r"\1", base)
    base = base.strip(" ,")
    if base == n or not base or base in ingredients._GENERIC or len(base) < 3:
        return None
    return _cased(name, base)


def made_from(name: str) -> Optional[tuple[str, float, dict]]:
    """(base name, grams of base per gram, own conversions) for a name in MADE_FROM, or None."""
    n = _spell(name)
    for rx, base, per_g, conv in MADE_FROM:
        m = re.search(rx, n)
        if m:
            b = re.sub(r"\s+", " ", m.expand(base)).strip() if "\\" in base else base
            if b == "onions":
                b = "yellow onions"           # caramelized onions are yellow ones unless it says
            return _cased(name, b), per_g, dict(conv)
    return None


def link(ingredient_id: str) -> Optional[dict]:
    """Give an ingredient its `from` (and the base its buying unit). Makes the base ingredient
    when the catalog has none yet. Returns the ingredient, or None when it comes from nothing."""
    from . import ingredients
    ing = ingredients.get(ingredient_id)
    if ing is None or ing.get("made"):
        return None
    buy_as(ingredient_id)
    got = made_from(ing["name"])
    if got is None:
        return None
    base_name, per_g, conv = got
    base = ingredients.add(base_name, category=ing.get("category") or "other")
    if base["id"] == ingredient_id:
        return None
    fields = {}
    if (ing.get("from") or {}).get("id") != base["id"]:
        fields["from"] = {"id": base["id"], "per_g": per_g}
    missing = {u: g for u, g in conv.items() if u not in (ing.get("unit_conversions") or {})}
    if missing:
        fields["unit_conversions"] = {**(ing.get("unit_conversions") or {}), **missing}
    if fields:
        ing = ingredients.update(ingredient_id, **fields)
    if not base.get("fdc_id"):
        ingredients.resolve_usda(base["id"])
    buy_as(base["id"])
    return ingredients.get(ingredient_id)


def buy_as(ingredient_id: str) -> None:
    """Garlic is bought by the head: a `head` conversion of 12 cloves, and the list says heads."""
    from . import ingredients
    ing = ingredients.get(ingredient_id)
    if ing is None:
        return
    rule = BUY_AS.get(_spell(ing["name"]))
    conv = ing.get("unit_conversions") or {}
    if rule is None or "head" in conv or rule[1] not in conv:
        return
    unit, by, n = rule
    ingredients.update(ingredient_id, unit_conversions={**conv, unit: conv[by] * n}, default_unit=unit)


def base_of(ing: dict, by_id: Optional[dict] = None) -> Optional[tuple[dict, float]]:
    """(base ingredient, grams of it per gram) for something made from another, else None."""
    src = ing.get("from") or {}
    if not src.get("id"):
        return None
    if by_id is None:
        from . import ingredients
        base = ingredients.get(src["id"])
    else:
        base = by_id.get(src["id"])
    return (base, float(src.get("per_g") or 1.0)) if base else None


def per100(ing: dict) -> Optional[dict]:
    """Nutrition of something made from another, per 100 g: the base's, times how much of the
    base went into each gram (caramelized onions: 4 g of onion in every gram)."""
    from . import nutrition
    got = base_of(ing)
    if got is None:
        return None
    base, per_g = got
    food = nutrition.nutrients_per_100g(base)
    if not food:
        return None
    out = {**food, **{k: food[k] * per_g for k in nutrition.NUTRIENT_KEYS if food.get(k) is not None}}
    out["vitamins"] = {k: v * per_g for k, v in (food.get("vitamins") or {}).items()}
    return out


def to_base(ing: dict, grams: float, by_id: dict) -> tuple[str, float]:
    """What a line takes from the kitchen: (ingredient id, grams). Caramelized onions take
    4 g of yellow onion a gram; everything else takes itself."""
    got = base_of(ing, by_id)
    if got is None:
        return ing["id"], grams
    return got[0]["id"], grams * got[1]
