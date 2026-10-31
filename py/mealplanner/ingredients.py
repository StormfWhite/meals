"""The local ingredient catalog -- "ingredients as used in my recipes".

Distinct from the raw USDA cache (Phase 3's fdc_cache.sqlite): an entry
here points at one chosen fdc_id, but the actual nutrient payload lives in
the cache so re-resolving isn't needed on every recipe read. Until an
ingredient is bound to FDC, `manual_nutrients` (per 100g) is the only
nutrition source for it -- entirely optional, since a recipe with unknown
ingredients still saves fine, it just can't be summed into a nutrition
total yet.
"""
from __future__ import annotations

import datetime
import functools
import math
import re
import threading
import uuid
from typing import Optional

from . import aisles, store
from .paths import INGREDIENTS_FILE

CATEGORIES = ("vegetable", "protein", "grain", "dairy", "fruit", "other")

# Units USDA reports portions in that are worth keeping as conversions --
# the rest of its portion table ("1 package (10 oz)") is packaging, not a
# way anyone writes an amount on a meal line.
KITCHEN_UNITS = {
    "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon",
    "teaspoons", "oz", "ounce", "ounces", "lb", "pound", "pounds", "clove",
    "cloves", "slice", "slices", "piece", "pieces", "medium", "large",
    "small", "head", "stalk", "sprig", "leaf", "bunch", "fillet", "breast",
    "thigh", "egg", "ear", "fruit", "berry", "wedge", "half", "quart", "pint",
}


# Every read-modify-write of the file holds this: the background USDA resolve and a Pantry add
# ran at once and the later save wiped the other's change ("4 32 oz cans" lost its can, 2026-10-25).
LOCK = threading.RLock()


def _locked(fn):
    @functools.wraps(fn)
    def run(*args, **kwargs):
        with LOCK:
            return fn(*args, **kwargs)
    return run


def _load() -> dict:
    return store.load(INGREDIENTS_FILE, {"ingredients": []})


def _save(data: dict) -> None:
    store.save(INGREDIENTS_FILE, data)


def _decorate(ingredient: dict) -> dict:
    """Fill in what an entry written by an older version doesn't have.

    Read-time only, deliberately: a catalog saved before shopping lists
    existed shouldn't have to be migrated on disk to be usable, and
    deriving here means one rule (aisles.list_for) decides for both old
    and new entries."""
    return {**ingredient, "shop_list": aisles.list_for(ingredient)}


def list_ingredients(q: Optional[str] = None) -> list[dict]:
    items = _load()["ingredients"]
    if q:
        q = q.strip().lower()
        items = [i for i in items if q in i["name"].lower()]
    return [_decorate(i) for i in sorted(items, key=lambda i: i["name"].lower())]


def by_id() -> dict[str, dict]:
    return {i["id"]: _decorate(i) for i in _load()["ingredients"]}


def get(ingredient_id: str) -> Optional[dict]:
    return by_id().get(ingredient_id)


@_locked
def add(name: str, category: str = "other", default_unit: str = "g",
        unit_conversions: Optional[dict] = None, store_section: Optional[str] = None,
        manual_nutrients: Optional[dict] = None, fdc_id: Optional[int] = None,
        shop_list: Optional[str] = None) -> dict:
    from . import forms
    # "garlic cloves", "minced garlic", "diced onion" ARE garlic and onion (forms.py): one of each
    base = forms.same_food(name)
    if base is not None:
        return add(base, category, default_unit, unit_conversions, store_section, manual_nutrients,
                   fdc_id, shop_list)
    data = _load()
    # one ingredient per name: a second "Yogurt" (two adds racing, the phone and the laptop)
    # would be offered twice everywhere
    same = next((i for i in data["ingredients"] if i["name"].strip().lower() == name.strip().lower()), None)
    if same is not None:
        return same
    ingredient = {
        "id": "i_" + uuid.uuid4().hex[:8],
        "name": name.strip(),
        "fdc_id": fdc_id,
        "fdc_description": None,
        "default_unit": default_unit or "g",
        "unit_conversions": unit_conversions or {},
        "category": category if category in CATEGORIES else "other",
        "store_section": store_section,
        "manual_nutrients": manual_nutrients,
        "shop_list": shop_list if shop_list in (aisles.GROCERY, aisles.MARKET) else None,
        "shop_list_locked": bool(shop_list),
        "created": datetime.date.today().isoformat(),     # how long it's had to be used (suggest.py)
    }
    data["ingredients"].append(ingredient)
    _save(data)
    # Note: binding to USDA is deliberately NOT done here. This function is
    # the data layer -- reached by every test and every bulk path -- and a
    # network call hidden inside it would make creating an ingredient
    # unpredictably slow and the test suite dependent on api.nal.usda.gov.
    # server.py resolves right after creating, which is the one funnel
    # everything the user types comes through.
    if not ingredient.get("shop_list"):
        ingredient = update(ingredient["id"], shop_list=aisles.list_for(ingredient),
                            lock_shop_list=False)
    return ingredient


@_locked
def update(ingredient_id: str, **fields) -> dict:
    data = _load()
    ing = next((i for i in data["ingredients"] if i["id"] == ingredient_id), None)
    if ing is None:
        raise KeyError(ingredient_id)
    kept = {u: g for u, g in (ing.get("unit_conversions") or {}).items() if u in ("block", ing.get("pack"))}
    for key in ("name", "fdc_id", "fdc_description", "default_unit", "unit_conversions",
                "category", "store_section", "manual_nutrients", "shop_list", "freezes", "keep_days", "storage",
                "nutrient_fill", "hide_suggest", "brand", "pack", "pack_size", "made", "from", "bought_to", "storage_by_hand"):
        if key in fields and fields[key] is not None:
            ing[key] = fields[key].strip() if key == "name" else fields[key]
    # a block or can size said in the Pantry ("frozen in 1 lb blocks", "4 32 oz cans",
    # stock.text_to_g) outlives a USDA lookup that started before it and writes its own portions
    if kept and fields.get("unit_conversions") is not None:
        ing["unit_conversions"] = {**ing["unit_conversions"], **{u: g for u, g in kept.items()
                                                                 if u not in fields["unit_conversions"]}}
    # Moving something between the two lists by hand is a decision, not a
    # guess -- once made it must survive every later re-derivation.
    if fields.get("shop_list") and fields.get("lock_shop_list", True):
        ing["shop_list_locked"] = True
    _save(data)
    return ing


def _portion_unit(name: str, food: str) -> Optional[str]:
    """One of USDA's portion names -> the unit a line would say, or None. Besides the plain ones
    ("cup", "clove"): "medium (7\" to 7-7/8\" long)" is "medium", "slice or wedge" is "slice",
    "fruit (2-3/8\" dia)" is "fruit", "whole" stays, and a portion named after the food itself
    ("banana" in Banana, raw; "avocado") is ONE of it -- "each". "nlea serving", codes: None."""
    from .nutrition import _stem
    u = re.sub(r"\s*\(.*$", "", (name or "").lower()).strip()
    if not u or u.startswith("extra ") or u[0].isdigit():
        return None
    if u in KITCHEN_UNITS:
        return u
    w0 = u.split()[0]
    if w0 == "whole":
        return "whole"
    if food and (_stem(w0) == food or _stem(u) == food):
        return "each"
    return w0 if w0 in KITCHEN_UNITS else None


def _kitchen_portions(nutrients: dict) -> dict:
    """USDA's portion table, as units anyone would actually write on a meal line -- "1 clove"
    and "1 medium" survive, "1 package (15 oz)" doesn't. First listed wins (USDA orders them)."""
    from .nutrition import _stem
    head = (nutrients.get("description") or "").split(",")[0].strip().lower()
    food = _stem(head.split()[-1]) if head else ""
    out: dict = {}
    for name, g in (nutrients.get("portions") or {}).items():
        unit = _portion_unit(name, food)
        if unit and unit not in out and g:
            out[unit] = g
    return out


# words on a package that say nothing about what the food is
_FILLER = r"\b(organic|natural|pure|raw|unfiltered|fresh|sliced|diced|chopped|pieces?|chunks?|whole|premium|plain)\b"


# how it gets typed -> how USDA spells it
_SPELLINGS = {"dragonfruit": "dragon fruit", "bannanas?": "banana", "bananna": "banana", "makgo": "mango", "yoghurt": "yogurt",
              "strawberrys": "strawberries", "blueberrys": "blueberries", "tomatos": "tomatoes",
              "carlic": "garlic", "garlik": "garlic", "pastery": "pastry", "spanikopita": "spanakopita"}
# a whole name that means one thing in a kitchen and another in USDA: "Pepper" by the teaspoon
# is black pepper, never "Pepper, banana, raw" (2026-10-26)
_MEANS = {"pepper": "black pepper", "ground pepper": "black pepper", "cracked pepper": "black pepper",
          "apple cider vinegar": "vinegar cider", "parmigiano reggiano": "cheese parmesan hard",
          "parmesan": "cheese parmesan hard", "romanesco": "cauliflower raw"}
# USDA has no plain version of these and its fuzzy match lands on a restaurant pizza: straight to
# the store's / Open Food Facts' label
_NO_USDA = {"pizza dough", "sourdough pizza dough"}


_GENERIC = {"fruit", "fruits", "vegetable", "vegetables", "meat", "mix", "blend", "sauce", "seeds",
            "berries", "berry", "greens", "nuts"}


def _usda_queries(name: str) -> list[str]:
    """What to ask USDA for, most specific first: the name, the name without package words
    ("organic raw and unfiltered honey" -> "honey"), then without a leading word USDA has
    never heard of -- a brand ("fage yogurt" -> "yogurt"), never a food ("almond butter")."""
    from . import fdc
    name = name.strip().lower()
    for typed, usda in _SPELLINGS.items():
        name = re.sub(rf"\b{typed}\b", usda, name)
    name = _MEANS.get(name, name)
    out = [name]
    clean = re.sub(r"\s{2,}", " ", re.sub(r"\band\b", " ", re.sub(_FILLER, " ", name))).strip(" ,")
    if clean and clean not in out and clean not in _GENERIC:      # "fresh berries" is no particular berry
        out.append(clean)
    if clean.startswith("frozen ") and clean[7:]:
        out.append(clean[7:])
    words = (out[-1]).split()
    def known(word: str) -> bool:
        try:
            return bool(fdc.search(word))
        except Exception:
            return True                 # can't tell: keep the word
    if "," in name:
        return []                       # several foods: only as a mix (_resolve_blend)
    # one leading brand at most, and never down to a word that names no food in particular
    if len(words) > 1 and words[-1] not in _GENERIC and not known(words[0]):
        out.append(" ".join(words[1:]))
    return list(dict.fromkeys(out))


_FOOD_WORDS = """avocado feta gnocchi parmesan parmigiano reggiano gruyere pistachio pistachios romanesco
cauliflower broccoli spinach kale arugula lettuce cabbage cucumber zucchini eggplant asparagus mushroom
mushrooms potato potatoes tomato tomatoes onion onions garlic ginger carrot carrots celery pepper peppers
strawberry strawberries blueberry blueberries raspberry raspberries blackberry blackberries mango pineapple
banana bananas apple apples orange oranges lemon lime grapes cherries peach peaches plum pear pears melon
watermelon cantaloupe almond almonds walnut walnuts cashew cashews pecan pecans hazelnut peanut peanuts
chickpeas lentils beans quinoa oats oatmeal barley couscous pasta spaghetti noodles bread bagel tortilla
yogurt cheese mozzarella cheddar ricotta cottage butter cream milk eggs tofu tempeh hummus tahini olive
vinegar mustard ketchup mayonnaise honey syrup sugar flour cornmeal cornstarch yeast cinnamon cumin paprika
turmeric oregano basil thyme rosemary parsley cilantro dill mint bouillon broth stock chocolate cocoa
coconut raisins cranberries dates figs prunes apricots pomegranate kiwi papaya artichoke beet beets radish
turnip squash pumpkin butternut leek shallot scallion cardamom nutmeg vanilla pizza dough crust""".split()


def _vocab(skip: str = "") -> set:
    words = set(_FOOD_WORDS)
    for i in by_id().values():
        if skip and i["name"].lower() == skip.lower():
            continue          # the ingredient's own (mistyped) words are no evidence
        words.update(re.findall(r"[a-z]{4,}", (i.get("name") or "").lower()))
        words.update(re.findall(r"[a-z]{4,}", (i.get("fdc_description") or "").lower()))
    return words


def _spell(name: str) -> Optional[str]:
    """The name with each word USDA has never heard of mended to the nearest known food word
    ("avacado" -> "avocado", "gnocci" -> "gnocchi"); None when nothing changed."""
    import difflib
    vocab = _vocab(name)
    out = []
    for w in re.findall(r"[A-Za-z']+|[^A-Za-z']+", name.lower()):
        if re.fullmatch(r"[a-z']{4,}", w) and w not in vocab:
            near = difflib.get_close_matches(w, vocab, n=1, cutoff=0.8)
            w = near[0] if near else w
        out.append(w)
    fixed = "".join(out)
    return fixed if fixed != name.lower() else None


# a descriptor between the name and the food USDA lists
_DESCRIPTORS = re.compile(r"\b(shelled|cave|aged|better|than|sourdough|unsweetened|fresh|organic|raw|sliced)\b")
_ALIASES = {"feta": "feta cheese", "gruyere": "gruyere cheese", "bullion": "bouillon"}


def _resolve_spelled(ingredient_id: str, ing: dict) -> Optional[dict]:
    """USDA again for a name that was a typo or wore a descriptor. The fixed name is only a
    query: the ingredient keeps the name the user typed."""
    from . import fdc
    low = ing["name"].strip().lower()
    if low in _NO_USDA or "," in low or " and " in low:
        return None           # several foods go to _resolve_blend; these never to a restaurant pizza
    tries = []
    fixed = _spell(ing["name"])
    for base in filter(None, (fixed, ing["name"].lower())):
        tries.append(base)
        trimmed = re.sub(r"\s{2,}", " ", _DESCRIPTORS.sub(" ", base)).strip()
        if trimmed and trimmed != base:
            tries.append(trimmed)
    for t in list(tries):
        for k, v in _ALIASES.items():
            if k in t:
                tries.append(t.replace(k, v))
    for q in dict.fromkeys(tries):
        if q == ing["name"].lower():
            continue          # the plain name already failed
        match = fdc.best_match(q)
        if match is not None:
            return _bind_match(ingredient_id, ing, match, q)
    return None


def _resolve_loose(ingredient_id: str) -> Optional[dict]:
    """Last resort: the store's label or Open Food Facts for an UNBRANDED name (brands.bind_loose)."""
    from . import brands, fdc
    try:
        return brands.bind_loose(ingredient_id)
    except fdc.NeedFetch:
        raise
    except Exception:
        return None


def _resolve_blend(ingredient_id: str, ing: dict) -> Optional[dict]:
    """A bag of mixed fruit ("strawberry, blueberry, and mango pieces"): equal parts of each,
    when every one of them is a USDA food -- otherwise nothing (no guessing)."""
    from . import fdc
    name = re.sub(_FILLER, " ", ing["name"].lower())
    name = re.sub(r"^\s*frozen\s+", "", name)
    for typed, usda in _SPELLINGS.items():
        name = re.sub(rf"\b{typed}\b", usda, name)
    parts = [p.strip() for p in re.split(r",|\band\b|&|/", name) if p.strip()]
    if len(parts) < 2:
        return None
    foods = []
    for part in parts:
        # the fruit itself -- "Strawberries, frozen", never "Strawberry drink syrup"
        names = {part, part + "s", part + "es", re.sub(r"y$", "ies", part)}
        hit = next((m for q in (part + " frozen", part + " raw", part)
                    for m in fdc.ranked_matches(q, limit=6)
                    if m["description"].lower().split(",")[0].strip() in names), None)
        food = hit and fdc.get_nutrients(hit["fdc_id"])
        if not food:
            return None
        foods.append(food)
    n = len(foods)
    blend = {k: round(sum(f.get(k, 0.0) for f in foods) / n, 2) for k in ("calories_kcal", "protein_g", "fiber_g")}
    vit = {}
    for f in foods:
        for k, v in (f.get("vitamins") or {}).items():
            vit[k] = vit.get(k, 0.0) + v / n
    blend["vitamins"] = {k: round(v, 2) for k, v in vit.items()}
    cups = [(_kitchen_portions(f).get("cup")) for f in foods]
    fields = {"manual_nutrients": blend, "fdc_description": "Equal parts: " + ", ".join(f["description"] for f in foods),
              "category": fdc.category_for(foods[0].get("food_category", "")) or ing.get("category")}
    if all(cups):
        fields["unit_conversions"] = {"cup": round(sum(cups) / n, 1), **(ing.get("unit_conversions") or {})}
    return update(ingredient_id, **fields)


def fill_portions(ingredient_id: str) -> Optional[dict]:
    """A matched ingredient whose USDA record has no kitchen measures, or leaves a nutrient out
    (Foundation "Chia seeds, dry, raw": no cup, no fiber): those from another record of the same
    food. The match itself stays as it is."""
    from . import fdc
    ing = get(ingredient_id)
    if not ing or not ing.get("fdc_id"):
        return ing
    missing = [k for k in (fdc.get_nutrients(ing["fdc_id"]) or {}).get("missing", [])
               if k not in (ing.get("nutrient_fill") or {})]
    need_portions = not ing.get("unit_conversions")
    if not missing and not need_portions:
        return ing
    head = ", ".join((ing.get("fdc_description") or "").split(",")[:2]).lower()
    want = head.split(",")[0].strip()
    fields: dict = {}
    # the closest record of the same food: fewest words the matched one doesn't have
    # ("Grapes, raw" for green seedless grapes -- never "Grapes, muscadine, raw")
    mine = set(re.split(r"[^a-z]+", (ing.get("fdc_description") or "").lower()))
    seen: dict = {}
    for query in dict.fromkeys([head.replace(",", ""), want] + _usda_queries(ing["name"])):
        for other in fdc.ranked_matches(query, limit=6):
            if other["fdc_id"] != ing["fdc_id"] and other["description"].lower().split(",")[0].strip() == want:
                seen.setdefault(other["fdc_id"], other)
    extra = lambda o: len(set(re.split(r"[^a-z]+", o["description"].lower())) - mine - {""})
    for other in sorted(seen.values(), key=lambda o: (extra(o), -o["score"])):
        food = fdc.get_nutrients(other["fdc_id"]) or {}
        portions = _kitchen_portions(food)
        if need_portions and portions and "unit_conversions" not in fields:
            fields["unit_conversions"] = portions
        value = lambda k: food.get(k) if k in food else (food.get("vitamins") or {}).get(k)
        got = {k: value(k) for k in missing if k not in food.get("missing", []) and value(k)}
        if got:
            fields["nutrient_fill"] = {**(ing.get("nutrient_fill") or {}), **fields.get("nutrient_fill", {}), **got}
            missing = [k for k in missing if k not in got]
        if not missing and (not need_portions or "unit_conversions" in fields):
            return update(ingredient_id, **fields)
    return update(ingredient_id, **fields) if fields else ing


MIN_COUNT_G = 15


def fill_count(ingredient_id: str) -> Optional[dict]:
    """What ONE of it weighs, when nothing says yet ("1 banana" weighed a 6 g slice): from its own
    USDA record read again (whole-item portions used to be dropped), else from the closest record
    of the same food (Banana, raw -> Bananas, raw's "medium"). Only adds units; nothing it has
    changes. No record says (spinach): left alone -- a bare count then has no weight."""
    from . import fdc, nutrition
    ing = get(ingredient_id)
    if not ing or ing.get("made") or not ing.get("fdc_id") or nutrition.count_grams(ing) is not None:
        return ing
    have = ing.get("unit_conversions") or {}
    counts = set(nutrition.COUNT_UNITS) | {"large", "small"}
    # one grape (7 g), one split pea (3 g): a bare "1" of those means a bunch or a bag, so it's
    # better unweighed (the Pantry then asks) than weighed as a single tiny piece
    pick = lambda portions: {u: g for u, g in portions.items() if u in counts and u not in have and g >= MIN_COUNT_G}
    found = pick(_kitchen_portions(fdc.get_nutrients(ing["fdc_id"]) or {}))
    if not any(u in nutrition.COUNT_UNITS for u in found):
        want = (ing.get("fdc_description") or "").split(",")[0].strip().lower()
        mine = set(re.split(r"[^a-z]+", (ing.get("fdc_description") or "").lower()))
        seen: dict = {}
        for query in dict.fromkeys([want] + _usda_queries(ing["name"])):
            for other in fdc.ranked_matches(query, limit=8):
                if nutrition._stem(other["description"].lower().split(",")[0].strip().split()[-1]) \
                        == nutrition._stem(want.split()[-1]) if want else False:
                    seen.setdefault(other["fdc_id"], other)
        extra = lambda o: len(set(re.split(r"[^a-z]+", o["description"].lower())) - mine - {""})
        for other in sorted(seen.values(), key=lambda o: (extra(o), -o["score"])):
            got = pick(_kitchen_portions(fdc.get_nutrients(other["fdc_id"]) or {}))
            if any(u in nutrition.COUNT_UNITS for u in got):
                found = got
                break
    if not any(u in nutrition.COUNT_UNITS for u in found):
        return ing
    return update(ingredient_id, unit_conversions={**have, **found})


def resolve_usda(ingredient_id: str, force: bool = False) -> Optional[dict]:
    """Bind an ingredient to the USDA food it most likely means, and take
    that food's category and portion table with it.

    Returns the updated ingredient, or None if nothing confident enough was
    found (in which case the ingredient is left exactly as it was -- an
    unbound ingredient still plans and shops fine, it just can't be counted
    into a nutrition total).
    """
    from . import fdc  # local: fdc pulls in requests, this module is imported everywhere

    ing = get(ingredient_id)
    if ing is None:
        raise KeyError(ingredient_id)
    if ing.get("made"):
        return ing          # a bulk make: its nutrition is what went into the pot (bulk.py)
    from . import forms
    if forms.link(ingredient_id):
        ing = get(ingredient_id)
        if not forms.OWN_NUTRITION.search(ing["name"]):
            return ing      # caramelized onions, cooked rice: the base re-weighed, no record of its own
    if (ing.get("fdc_id") or (ing.get("fdc_description") or "").startswith("Equal parts")) and not force:
        return ing
    match = None
    for query in ([] if ing["name"].strip().lower() in _NO_USDA else _usda_queries(ing["name"])):
        match = fdc.best_match(query)
        if match is not None:
            break
    if match is None:
        # the fallback chain: a typo mended / a descriptor dropped (USDA again), a product the
        # store or Open Food Facts knows (brands.py), a blend -- never a guess
        if ing.get("manual_nutrients"):
            return _with_brand(ingredient_id) or ing        # typed in by hand: no guessing over it
        found = _resolve_spelled(ingredient_id, ing)
        if found:
            return found
        return _with_brand(ingredient_id) or _resolve_blend(ingredient_id, ing) or _resolve_loose(ingredient_id)
    return _bind_match(ingredient_id, ing, match, query)


def _bind_match(ingredient_id: str, ing: dict, match: dict, query: str) -> Optional[dict]:
    """Take a USDA match's category, portions and nutrition onto the ingredient."""
    from . import fdc
    fields: dict = {"fdc_id": match["fdc_id"], "fdc_description": match["description"]}
    category = fdc.category_for(match.get("food_category", ""))
    if category != "other":
        fields["category"] = category

    nutrients = fdc.get_nutrients(match["fdc_id"]) or {}
    portions = _kitchen_portions(nutrients)
    if not portions:
        # The best-nutrition record often has no kitchen measures at all:
        # USDA's Foundation "Garlic, raw" lists only a reference amount,
        # while the SR Legacy entry for the same food is the one that knows
        # a clove is 3g (measured). So nutrition comes from the best match
        # and the portions come from whichever record for the same name
        # actually has them.
        for other in fdc.ranked_matches(query, limit=3):
            if other["fdc_id"] == match["fdc_id"]:
                continue
            portions = _kitchen_portions(fdc.get_nutrients(other["fdc_id"]) or {})
            if portions:
                break
    if portions:
        # Never clobber a conversion the user set by hand for this unit.
        fields["unit_conversions"] = {**portions, **(ing.get("unit_conversions") or {})}

    updated = update(ingredient_id, **fields)
    if not updated.get("shop_list_locked"):
        updated = update(ingredient_id, shop_list=aisles.classify(updated["name"], updated["category"]),
                         lock_shop_list=False)
    filled = fill_portions(ingredient_id) or updated
    filled = fill_count(ingredient_id) or filled
    return _with_brand(ingredient_id) or filled


def _with_brand(ingredient_id: str) -> Optional[dict]:
    """A name that names a product ("Crisp apple olipop") gets that product's label (brands.py)."""
    from . import brands, fdc
    try:
        return brands.bind(ingredient_id)
    except fdc.NeedFetch:
        raise
    except Exception:
        return None


WHOLE_UNITS = {"each", "head", "bunch", "piece", "whole", "medium", "large", "small", "fruit", "egg", "clove", "can", "jar", "bottle", "bag", "pack"}


def humanize_grams(ingredient: dict, grams: float) -> str:
    """A gram amount in whatever kitchen unit the ingredient is normally
    bought in, since "920g eggplant" reads worse than "2 medium"."""
    unit = ingredient.get("default_unit", "g")
    per_unit = (ingredient.get("unit_conversions") or {}).get(unit)
    if unit == "g" or not per_unit:
        return f"{grams:.0f} g"
    if unit in WHOLE_UNITS:                     # nobody buys 2.5 onions either: whole ones, rounded up
        n = max(1, math.ceil(grams / per_unit - 0.05))
        word = "" if unit == "each" else (unit if n == 1 else {"bunch": "bunches", "box": "boxes"}.get(unit, unit + "s"))
        return f"{n:g} {word}".strip()
    count = round((grams / per_unit) * 2) / 2  # nearest half unit
    return f"{count:g} {unit}"


@_locked
def delete(ingredient_id: str) -> bool:
    data = _load()
    before = len(data["ingredients"])
    data["ingredients"] = [i for i in data["ingredients"] if i["id"] != ingredient_id]
    _save(data)
    return len(data["ingredients"]) < before
