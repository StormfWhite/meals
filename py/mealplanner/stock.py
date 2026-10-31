"""What's on hand -- fridge, pantry and freezer -- and what each buy leaves over.

Storm 2026-10-19: the list should say exact amounts and "do the math of how much will be left over
at the end of the week or unused in the following week", buying in bulk to freeze, and "stuff that
lasts a while like garlic … track through the weeks how long that will last through the meals and
when it runs out"; and meals should take from what's there before adding to the list.

Nothing here is logged. Stock is REPLAYED, week by week from STOCK_START, out of what the list
already records (a ticked item = bought; `bought_qty_g` when known, else what the list said to
buy) and what the plan cooks (groceries' meal needs), so the laptop and the phone can't disagree
and nothing drifts. In each week: buy, then cook from the oldest lot first (fridge/pantry before
freezer), then age -- a lot past its keep days goes to the freezer if it freezes, else it's
counted wasted. The only thing stored is a correction ("actually 1 lb left"), in stock.json,
which sets the amount at the start of the week it was made in.

Weeks past the plan cook at the usual weekly use (the average of the planned weeks before), which
is what makes "lasts till ~Nov 9" possible for garlic bought by the bag.
"""
from __future__ import annotations

import datetime
import math
import re
import time
from typing import Optional

from . import aisles, board, ingredients, learning, prices, store
from .paths import DATA_DIR

STOCK_FILE = DATA_DIR / "stock.json"
STOCK_START = "2026-10-18"      # the first week whose ticks count as stock -- older ones never did
FREEZER_DAYS = 180
PROJECT_WEEKS = 12              # how far ahead "runs out" looks
USUAL_LOOKBACK = 8
BULK_MIN_SAVING = 0.10          # a bigger pack has to be this much cheaper per gram
BULK_HORIZON_WEEKS = 13         # ...and get used within about three months
OFTEN_WEEKS = 3                 # bought in this many of the last USUAL_LOOKBACK weeks = "often"

# (name pattern, keep days, freezes) -- first match wins; then the category's default
KEEPS = [
    (r"\bfrozen\b", 180, True),
    (r"garlic|shallot", 60, False),
    (r"\bonions?\b", 30, False),
    (r"potato|yam", 21, False),
    (r"\b(rice|flour|pasta|noodles?|oats?|quinoa|lentils?|dried|spices?|salt|sugar|oil|vinegar|honey|"
     r"syrup|sauce|seeds?|nuts?|almonds?|cashews?|walnuts?|peanuts?|butter \w+|\w+ butter|"
     r"cumin|paprika|cinnamon|pepper flakes|baking|cocoa|coffee|tea|canned|beans)\b", 365, False),
    (r"spinach|lettuce|greens|arugula|kale|chard|cilantro|parsley|basil|mint|herbs?|sprouts", 5, False),
    (r"berr(y|ies)", 4, True),
    (r"banana|avocado|tomato|peach|plum|pear|mango", 5, False),
    (r"bread|tortillas?|bagels?|buns?|pitas?", 5, True),
    (r"\bbutter\b", 30, True),
    (r"cheese", 21, True),
    (r"milk|yogh?urt|cream|kefir", 10, False),
    (r"\beggs?\b", 28, False),
    (r"chicken|beef|pork|turkey|lamb|fish|salmon|tuna|shrimp|sausage|bacon|meat|steak|ground", 2, True),
    (r"tofu|tempeh", 7, False),
    (r"juice", 10, True),
]
CATEGORY_KEEPS = {"vegetable": (7, False), "fruit": (7, False), "protein": (3, True),
                  "grain": (365, False), "dairy": (10, False), "other": (30, False)}


def keeps(ing: dict) -> tuple[int, bool]:
    """(days it keeps in the fridge/pantry, whether it freezes) -- the ingredient's own say first."""
    days, freezes = CATEGORY_KEEPS.get(ing.get("category", "other"), (30, False))
    name = (ing.get("name") or "").lower()
    for pattern, d, f in KEEPS:
        if re.search(pattern, name):
            days, freezes = d, f
            break
    if ing.get("keep_days"):
        days = int(ing["keep_days"])
    if ing.get("freezes") is not None:
        freezes = bool(ing["freezes"])
    return days, freezes


FRIDGE_NAMES = r"\beggs?\b|cheese|\bbutter\b|milk|yogh?urt|cream|kefir|tofu|tempeh|juice"
MADE_GRACE_DAYS = 7            # a bulk pot left in the fridge past its use-by: counted this long more, then gone
LOW_DAYS = 7                    # runs out within this long after the list week starts = running low


def storage(ing: dict) -> str:
    """Where it lives when it isn't frozen: "pantry" for what keeps three weeks or more on a shelf
    (garlic, onions, rice, spices), else "fridge". The ingredient's own `storage` wins."""
    if ing.get("storage") in ("fridge", "pantry"):
        return ing["storage"]
    if ing.get("bought_to") in ("fridge", "pantry"):        # where Kroger shelves it
        return ing["bought_to"]
    from . import aisles
    if aisles.list_for(ing) == aisles.MARKET:              # from the farmer's market: assume the fridge
        return "fridge"
    if re.search(FRIDGE_NAMES, (ing.get("name") or "").lower()):
        return "fridge"
    days, _ = keeps(ing)
    return "pantry" if days >= 21 and ing.get("category") != "dairy" else "fridge"


# ── amounts in the units the store sells by ─────────────────────────────

def us_amount(grams: Optional[float]) -> str:
    """Ounces under a pound, pounds (one decimal) from there -- what a package says."""
    if not grams or grams <= 0:
        return ""
    oz = grams / 28.3495
    if oz < 15.95:
        return f"{oz:.1f} oz".replace(".0 oz", " oz") if oz < 10 else f"{oz:.0f} oz"
    return f"{grams / 453.592:.1f} lb".replace(".0 lb", " lb")


def plan_buy(need_g: float, on_hand_g: float, extra_g: float, typed_g: Optional[float],
             package_g: Optional[float], hand_added: bool) -> dict:
    """What to buy for one row: what the meals need beyond what's on hand, plus whatever was
    added by hand on top, in whole packages when the package size is known. A typed amount
    on the row is what gets bought. Grams unknown (a bare hand-add, no package) = None."""
    if typed_g:
        to_buy = typed_g
    else:
        to_buy = max(0.0, need_g - on_hand_g) + (extra_g or 0.0)
    if to_buy <= 0.5 and hand_added and not need_g:
        # "garlic" typed with no amount: one of whatever the store sells, if that's known
        return {"to_buy_g": None, "packages": 1 if package_g else None, "buy_g": package_g}
    if to_buy <= 0.5:
        return {"to_buy_g": 0.0, "packages": 0, "buy_g": 0.0}
    if package_g and package_g > 0:
        packages = max(1, math.ceil(to_buy / package_g - 0.03))   # 16.2 oz needed of a 16 oz pack: 1
        return {"to_buy_g": to_buy, "packages": packages, "buy_g": packages * package_g}
    return {"to_buy_g": to_buy, "packages": None, "buy_g": to_buy}


# ── the replay ───────────────────────────────────────────────────────────

def _add_days(iso: str, days: int) -> str:
    return (datetime.date.fromisoformat(iso) + datetime.timedelta(days=days)).isoformat()


def _load_corrections() -> list[dict]:
    return store.load(STOCK_FILE, {"corrections": []}).get("corrections", [])


def correct(ingredient_id: str, grams: float, week_start_iso: str, frozen: Optional[bool] = None) -> None:
    """"There's actually this much" -- from the start of that week on. `frozen` narrows it to the
    freezer (True) or the fridge/pantry (False); None = all of it."""
    data = store.load(STOCK_FILE, {"corrections": []})
    keep = [c for c in data.get("corrections", [])
            if not (c["id"] == ingredient_id and c["week"] == week_start_iso and c.get("frozen") == frozen)]
    keep.append({"id": ingredient_id, "g": max(0.0, float(grams)), "week": week_start_iso,
                 "frozen": frozen, "at": time.time()})
    data["corrections"] = keep
    store.save(STOCK_FILE, data)


BLOCKS = re.compile(r"^\s*([\d.]+)\s*blocks?\b\s*(?:(?:of|x|×|@|,)\s*)?(.*)$", re.I)

# What things come in (Storm 2026-10-25: "4 32 oz canned tomatoes"). The size said with one is
# remembered on the ingredient (unit_conversions[word], `pack` = the word) like a block's.
PACKS = {"can": "can", "cans": "can", "jar": "jar", "jars": "jar", "bag": "bag", "bags": "bag",
         "box": "box", "boxes": "box", "bottle": "bottle", "bottles": "bottle", "carton": "carton",
         "cartons": "carton", "package": "package", "packages": "package", "pkg": "package",
         "pkgs": "package", "pack": "package", "packs": "package", "tub": "tub", "tubs": "tub",
         "tin": "tin", "tins": "tin", "pouch": "pouch", "pouches": "pouch",
         "container": "container", "containers": "container"}
_PACK = "|".join(sorted(PACKS, key=len, reverse=True))
_SIZE = r"\(?\s*([\d.]+\s*-?\s*(?:fl\.?\s*oz|oz|ounces?|lbs?|pounds?|kg|g|grams?|ml|l|liters?|litres?)\.?)\s*\)?"
_TIMES = r"(?:x|×|\*|@)"
# "4 32 oz cans", "4 x 32 oz", "4 (32 oz) cans" / "4 cans of 32 oz", "4 cans, 32 oz each" / "32 oz cans x 4"
COUNT_SIZE = [
    # the count needs a space or a times sign after it: "32 oz" is one size, never 3 × "2 oz"
    (re.compile(rf"^([\d.]+)(?:\s*{_TIMES}\s*|\s+){_SIZE}\s*(?:({_PACK})\b)?\s*(?:each)?$", re.I), 1, 2, 3),
    (re.compile(rf"^([\d.]+)\s*({_PACK})\b\s*(?:(?:of|x|×|@|,|at)\s*)?{_SIZE}\s*(?:each)?$", re.I), 1, 3, 2),
    (re.compile(rf"^{_SIZE}\s*(?:({_PACK})\b)?\s*{_TIMES}\s*([\d.]+)$", re.I), 3, 1, 2),
]


def size_g(text: str) -> Optional[float]:
    """One package's size -> grams: weights, and liquids at a gram a millilitre."""
    t = re.sub(r"(\d)\s*-\s*", r"\1 ", (text or "").strip().lower())
    m = re.match(r"^([\d.]+)\s*(fl\.?\s*oz|ml|l|liters?|litres?)\b", t)
    if m:
        unit = m.group(2)
        return float(m.group(1)) * (29.5735 if unit.startswith("fl") else 1.0 if unit == "ml" else 1000.0)
    return prices._parse_grams(t)


def typed_g(text: str, ing: Optional[dict] = None) -> Optional[float]:
    """An amount typed on the list -> grams: "2 lb", several of one size ("4 x 32 oz", "4*32 oz",
    "32 oz × 4") multiplied, and with the ingredient anything it can weigh ("6 bananas", "2 cups").
    Nothing is remembered on the ingredient here."""
    t = (text or "").strip()
    for rx, n_at, size_at, _ in COUNT_SIZE:
        m = rx.match(t)
        if m and size_g(m.group(size_at)):
            try:
                return float(m.group(n_at)) * size_g(m.group(size_at))
            except ValueError:
                pass
    if ing is not None:
        from . import nutrition
        g = nutrition.text_to_grams(ing, t)
        if g:
            return g
    return size_g(t)


def amount_g(ing: dict, text: str) -> Optional[float]:
    """What's typed in the Pantry's add box -> grams, however it's said (nutrition.parse_amount):
    "2 lb", "1/2 cup", "1 banana", "a dozen", "3 cloves", "2 cans". A bare number after "4 x 32 oz"
    is that many of that size. Nothing it can weigh -> None (the box asks again), never a guess."""
    from . import nutrition
    got = nutrition.parse_amount(text)
    if got:
        qty, word = got
        if not word and qty >= 20:
            return qty                                   # a bare "200" is grams, never 200 bananas (or packs)
        if not word and (ing.get("pack_size") or {}).get("g"):
            return qty * ing["pack_size"]["g"]          # "3" after "4 x 32 oz" = three of those
        if not word and nutrition.count_grams(ing) is None:
            return None
        g = nutrition.qty_to_grams(ing, qty, PACKS.get(word) or word)
        if g:
            return g
    return size_g(text)                                  # ml / l / fl oz at a gram a millilitre


def block_g(ing: dict) -> Optional[float]:
    """How much one frozen block of it is ("frozen in 1 lb blocks"), once it's been said."""
    return (ing.get("unit_conversions") or {}).get("block")


def _count_text(n: float, word: str) -> str:
    n = round(n * 2) / 2
    plural = "es" if word in ("box", "pouch") else "s"
    return f"{n:g} {word}{'' if n == 1 else plural}"


def blocks_text(ing: dict, grams: float) -> Optional[str]:
    """ "3 blocks" for a freezer amount, when the ingredient is frozen in blocks."""
    size = block_g(ing)
    if not size or grams <= 0.5:
        return None
    return _count_text(grams / size, "block")


def size_text(text: str) -> str:
    """ "32oz" / "32-oz" / "(32 ounces)" -> "32 oz", the way the row shows it."""
    m = re.match(r"^\(?\s*([\d.]+)\s*-?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|kg|g|grams?|ml|l|liters?|litres?)",
                 (text or "").strip().lower())
    if not m:
        return (text or "").strip()
    unit = m.group(2)
    unit = ("fl oz" if unit.startswith("fl") else "oz" if unit.startswith("o") else "lb" if unit[0] in "lp"
            and unit not in ("l", "liter", "liters", "litre", "litres") else "l" if unit.startswith("l")
            else "g" if unit.startswith("g") else unit)
    return f"{float(m.group(1)):g} {unit}"


def made_text(ing: dict, grams: float) -> Optional[str]:
    """ "5.5 cups" of something made in bulk, in the units its pot was said to make (bulk.py)."""
    unit = (ing.get("made") or {}).get("unit") or {}
    if not unit.get("g") or grams <= 0.5:
        return None
    n = round(grams / unit["g"] * 4) / 4 if grams / unit["g"] < 10 else round(grams / unit["g"])
    word = unit["word"]
    plural = "" if n == 1 or word in ("fl oz", "oz", "ml", "l", "qt", "pt", "c") else "es" if word in ("box", "pouch") else "s"
    return f"{n:g} {word}{plural}"


def pack_text(ing: dict, grams: float) -> Optional[str]:
    """ "4 × 32 oz" for what's in the kitchen, once it was put in as several of one size."""
    if ing.get("made"):
        return made_text(ing, grams)
    size = ing.get("pack_size") or {}
    if not size.get("g") or grams <= 0.5:
        return None
    return f"{round(grams / size['g'] * 2) / 2:g} × {size['text']}"


def _remember(ing: dict, unit: Optional[str], size: float, text: Optional[str] = None) -> None:
    conv = dict(ing.get("unit_conversions") or {})
    fields = {}
    if unit and conv.get(unit) != size:
        conv[unit] = size
        fields["unit_conversions"] = conv
    if unit and unit != "block" and ing.get("pack") != unit:
        fields["pack"] = unit
    if text and ing.get("pack_size") != {"g": size, "text": text}:
        fields["pack_size"] = {"g": size, "text": text}
    if fields:
        ing.update(fields)
        ingredients.update(ing["id"], **fields)


def text_to_g(ing: dict, text: str) -> Optional[float]:
    """What's typed in the Pantry -> grams. Besides "2 lb" and counts, frozen blocks (Storm
    2026-10-22: "ingredients can be frozen and whole meal blocks"): "3 blocks of 1 lb" says how
    big a block is and remembers it on the ingredient (unit "block", so a meal line can say
    "1 block" too); "3 blocks" afterwards uses that. Several of one size multiply: "4 32 oz cans",
    "4 x 32 oz", "4 jars of 16 oz" (Storm 2026-10-25) -- the size is remembered and the row reads
    "4 × 32 oz", the way it was said."""
    text = (text or "").strip()
    m = BLOCKS.match(text)
    if m:
        size = size_g(m.group(2)) if m.group(2).strip() else None
        if size:
            _remember(ing, "block", size)
        size = size or block_g(ing)
        return float(m.group(1)) * size if size else None
    for rx, n_at, size_at, pack_at in COUNT_SIZE:
        m = rx.match(text)
        if not m:
            continue
        size = size_g(m.group(size_at))
        try:
            n = float(m.group(n_at))
        except ValueError:
            continue
        if not size:
            continue
        _remember(ing, PACKS.get((m.group(pack_at) or "").lower()), size, size_text(m.group(size_at)))
        return n * size
    return amount_g(ing, text)


def add(ingredient_id: str, grams: float, week_start_iso: str, where: Optional[str] = None) -> None:
    """Put some in the pantry by hand: on top of what's already there. `where` is "fridge",
    "pantry" (dry) or "freezer"; fridge/pantry also becomes where that ingredient lives."""
    ing = ingredients.get(ingredient_id) or {}
    if where in ("fridge", "pantry") and storage(ing) != where:
        ingredients.update(ingredient_id, storage=where)
    frozen = where == "freezer"
    have = Ledger().state(week_start_iso).get(ingredient_id, [])
    now = sum(l["g"] for l in have if l["frozen"] == frozen)
    correct(ingredient_id, now + max(0.0, float(grams)), week_start_iso, frozen)


def move(ingredient_id: str, week_start_iso: str, to: str, from_frozen: bool = False) -> None:
    """The Pantry's section icon: fridge <-> dry changes where the ingredient lives (and so
    every later week); into or out of the freezer moves that much of it there."""
    lots = Ledger().state(week_start_iso).get(ingredient_id, [])
    fresh = sum(l["g"] for l in lots if not l["frozen"])
    frozen = sum(l["g"] for l in lots if l["frozen"])
    if to == "freezer":
        if not from_frozen:
            correct(ingredient_id, 0, week_start_iso, False)
            correct(ingredient_id, frozen + fresh, week_start_iso, True)
        return
    if to in ("fridge", "pantry"):
        ingredients.update(ingredient_id, storage=to)
        if from_frozen:
            correct(ingredient_id, 0, week_start_iso, True)
            correct(ingredient_id, fresh + frozen, week_start_iso, False)


def _brand(label: str) -> str:
    """ "Simple Truth® Creamy … · 16 oz" -> "simple truth": the words before the first ®/™, else
    the first word -- what "the same product, a bigger size" has to share."""
    name = (label or "").split(" · ")[0]
    m = re.match(r"^(.*?)[®™]", name)
    return (m.group(1) if m else name.split(" ")[0]).strip().lower()


def product_name(label: str) -> str:
    """What the store calls it, without the size or the ® marks -- shown under the row."""
    name = re.sub(r"[®™]", "", (label or "").split(" · ")[0])
    # the size is said by the math beside it: "…Rice, 32 oz (907g)" / "…Juice, 16 Ounce" -> gone
    name = re.sub(r",?\s*\d+(\.\d+)?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|g|kg|ct|count)\b.*$", "", name, flags=re.I)
    return re.sub(r"\s{2,}", " ", name).strip(" ,")


class Ledger:
    """One read of the plan and the list, for one drawing of the list (the files are read
    once per week asked about, not once per row)."""

    def __init__(self):
        from . import groceries
        self._g = groceries
        self.ings = ingredients.by_id()
        self.weeks = groceries._load()["weeks"]
        self.corrections = _load_corrections()
        self.shops = {k: groceries.active_shop(k) for k in (aisles.GROCERY, aisles.MARKET)}
        self._prices = prices._load()["prices"]
        self._needs: dict[str, dict[str, float]] = {}
        self._planned: dict[str, bool] = {}
        self._usual: Optional[dict[str, float]] = None
        self._states: dict[str, dict] = {}
        self._make_short: dict[str, dict[str, float]] = {}

    def make_short(self, week: str) -> dict[str, float]:
        """What the week's bulk makes (bulk.py) needed beyond what was on hand -- on the list."""
        self.state(week)
        return self._make_short.get(week, {})

    # what the plan cooks
    def needs(self, week: str) -> dict[str, float]:
        if week not in self._needs:
            raw = self._g.week_ingredient_needs(week)
            need = {i: learning.seeded_quantity(i, g) for i, g in raw.items()}
            for i, g in self.make_short(week).items():
                need[i] = need.get(i, 0.0) + g
            self._needs[week] = need
            self._planned[week] = bool(board.get_week(week)["slots"])
        return self._needs[week]

    def planned(self, week: str) -> bool:
        self.needs(week)
        return self._planned[week]

    def usual(self, before_week: str) -> dict[str, float]:
        """Average grams a week over the last planned weeks -- what an unplanned week will cook."""
        if self._usual is None:
            weeks = [_add_days(before_week, -7 * k) for k in range(1, USUAL_LOOKBACK + 1)]
            planned = [w for w in weeks if self.planned(w)]
            tot: dict[str, float] = {}
            for w in planned:
                for i, g in self.needs(w).items():
                    tot[i] = tot.get(i, 0.0) + g
            self._usual = {i: g / len(planned) for i, g in tot.items()} if planned else {}
        return self._usual

    def cooks(self, week: str, list_week: str) -> dict[str, float]:
        """What gets cooked that week: the plan, or the usual for a week nothing is planned in
        yet (only ever ahead of the list week -- the past is what was planned)."""
        if self.planned(week) or week < list_week:
            return self.needs(week)
        return self.usual(list_week)

    # the store's package for a row
    def package(self, week: str, ing_id: str, chosen: bool = True) -> Optional[dict]:
        """The pack picked on the row (`chosen`), else the store's match for the ingredient."""
        st = self.weeks.get(week, {}).get("items", {}).get(ing_id, {})
        if chosen and st.get("package"):
            return st["package"]
        ing = self.ings.get(ing_id)
        shop = self.shops.get(self.list_of(week, ing_id)) if ing else None
        return self._prices.get(prices._store_key(shop), {}).get(ing_id)

    def sizes(self, week: str, ing_id: str) -> list[dict]:
        """Every size the store carries of what this ingredient matched: the match itself, then
        the other sizes the search found (prices.kroger_price `options`), smallest first."""
        base = self.package(week, ing_id, chosen=False) or {}
        out = {}
        for o in [base] + list(base.get("options") or []):
            if o.get("package_g") and o.get("price"):
                g = round(o["package_g"])
                if g not in out or o["price"] < out[g]["price"]:
                    out[g] = {"package_g": o["package_g"], "price": o["price"], "label": o.get("label", "")}
        return sorted(out.values(), key=lambda o: o["package_g"])

    def best_package(self, week: str, ing_id: str, to_buy_g: float) -> Optional[dict]:
        """The size to buy (Storm: "auto bump up the size when i need more to an actual size that
        is carried"): the cheapest way to cover what's needed out of the sizes of the SAME brand
        -- 22 oz needed is one 32 oz jar, not two 16s, when that costs less -- fewest grams on a
        tie. A pack picked by hand on the row always wins."""
        picked = self.package(week, ing_id)
        base = self.package(week, ing_id, chosen=False)
        if picked is not base or not base or not to_buy_g or not base.get("package_g"):
            return picked
        brand = _brand(base.get("label", ""))
        best, best_key = base, None
        for o in self.sizes(week, ing_id):
            if _brand(o["label"]) != brand:
                continue
            n = max(1, math.ceil(to_buy_g / o["package_g"] - 0.03))
            key = (round(n * o["price"], 2), n * o["package_g"])
            if best_key is None or key < best_key:
                best, best_key = o, key
        if best is not base and round(best["package_g"]) == round(base["package_g"]):
            return base
        return best if best is base else {**base, **best}

    def list_of(self, week: str, ing_id: str) -> str:
        st = self.weeks.get(week, {}).get("items", {}).get(ing_id, {})
        ing = self.ings.get(ing_id)
        return st.get("shop_list") or (aisles.list_for(ing) if ing else aisles.GROCERY)

    def row_buy(self, week: str, ing_id: str, on_hand_g: float) -> dict:
        wk = self.weeks.get(week, {})
        st = wk.get("items", {}).get(ing_id, {})
        ex = wk.get("extra_items", {}).get(ing_id)
        # an amount typed on the row replaces the math; one typed when adding ("garlic 8 oz")
        # is bought on top of what the meals need
        typed = st.get("qty_text")
        ing = self.ings.get(ing_id)
        typed_amt = typed_g(typed, ing) if typed else None
        extra_g = (ex or {}).get("qty_g", 0.0) + (typed_g((ex or {}).get("qty_text") or "", ing) or 0.0)
        need = self.needs(week).get(ing_id, 0.0)
        want = typed_amt or max(0.0, need - on_hand_g) + extra_g
        pkg = self.best_package(week, ing_id, want) or {}
        out = plan_buy(need, on_hand_g, extra_g, typed_amt, pkg.get("package_g"), ex is not None)
        out["package"] = pkg or None
        return out

    # stock at the START of a week (before that week's shop)
    def state(self, week: str) -> dict[str, list[dict]]:
        if week in self._states:
            return self._copy(self._states[week])
        if week <= STOCK_START:
            lots: dict[str, list[dict]] = {}
        else:
            prev = _add_days(week, -7)
            lots = self.state(prev)
            self._buy(prev, lots)
            self._cook_and_age(prev, lots, self.needs(prev), {})
        self._correct(week, lots)
        self._states[week] = self._copy(lots)
        return lots

    @staticmethod
    def _copy(lots: dict) -> dict:
        return {i: [dict(l) for l in ls] for i, ls in lots.items()}

    @staticmethod
    def total(lots: list[dict]) -> float:
        return sum(l["g"] for l in lots)

    def _buy(self, week: str, lots: dict) -> None:
        for ing_id, st in self.weeks.get(week, {}).get("items", {}).items():
            if not st.get("checked") or ing_id not in self.ings:
                continue
            got = st.get("bought_qty_g")
            if got is None:
                got = self.row_buy(week, ing_id, self.total(lots.get(ing_id, []))).get("buy_g")
            if got:
                # into the freezer if that's where the store keeps it (Kroger's own shelf, prices.keep_where)
                lots.setdefault(ing_id, []).append({"g": float(got), "since": week,
                                                    "frozen": self.ings[ing_id].get("bought_to") == "freezer"})

    def _cook_and_age(self, week: str, lots: dict, cook: dict[str, float], tally: dict) -> None:
        """Cook `cook` out of `lots` (oldest first, freezer last), then age what's left by a
        week. `tally[ing] = {"short": g, "frozen": g, "wasted": g}` for whoever asks."""
        end = _add_days(week, 7)
        for ing_id, want in cook.items():
            have = lots.get(ing_id, [])
            have.sort(key=lambda l: (l["frozen"], l["since"]))
            for lot in have:
                take = min(lot["g"], want)
                lot["g"] -= take
                want -= take
                if want <= 0:
                    break
            if want > 0.5:
                tally.setdefault(ing_id, {}).setdefault("short", 0.0)
                tally[ing_id]["short"] += want
        for ing_id, have in list(lots.items()):
            ing = self.ings.get(ing_id)
            days, freezes = keeps(ing) if ing else (30, False)
            kept = []
            for lot in have:
                if lot["g"] <= 0.5:
                    continue
                age = (datetime.date.fromisoformat(end) - datetime.date.fromisoformat(lot["since"])).days
                # a bulk pot stays where it was put: the replay doesn't freeze it for you (Storm
                # 2026-10-26: "why does it say it is in the freezer when I put it in the fridge").
                # Past its days it shows "use by" in the Pantry; a week after that it's gone.
                if not lot["frozen"] and ing and ing.get("made") and days < age <= days + MADE_GRACE_DAYS:
                    kept.append(lot)
                    continue
                if not lot["frozen"] and age > days:
                    key = "frozen" if freezes and not (ing and ing.get("made")) else "wasted"
                    t = tally.setdefault(ing_id, {})
                    t[key] = t.get(key, 0.0) + lot["g"]
                    if key == "frozen":
                        kept.append({"g": lot["g"], "since": end, "frozen": True})
                    continue
                if lot["frozen"] and age > FREEZER_DAYS:
                    t = tally.setdefault(ing_id, {})
                    t["wasted"] = t.get("wasted", 0.0) + lot["g"]
                    continue
                kept.append(lot)
            if kept:
                lots[ing_id] = kept
            else:
                lots.pop(ing_id, None)

    def _correct(self, week: str, lots: dict) -> None:
        """The week's corrections and bulk makes, in the order they were made."""
        from . import bulk
        events = [("fix", c) for c in self.corrections if c["week"] == week]
        if week >= STOCK_START:
            events += [("make", m) for m in bulk.in_week(week)]
        short = self._make_short.setdefault(week, {})
        for kind, c in sorted(events, key=lambda e: e[1].get("at", 0)):
            if kind == "make":
                self._make(c, lots, short)
                continue
            have = lots.get(c["id"], [])
            part = [l for l in have if c.get("frozen") is None or l["frozen"] == c["frozen"]]
            rest = [l for l in have if l not in part]
            now = self.total(part)
            if c["g"] <= 0.5:
                part = []
            elif now > 0:
                for l in part:
                    l["g"] *= c["g"] / now
            else:
                part = [{"g": c["g"], "since": week, "frozen": bool(c.get("frozen"))}]
            lots[c["id"]] = rest + part
            if not lots[c["id"]]:
                lots.pop(c["id"])

    def _make(self, m: dict, lots: dict, short: dict) -> None:
        """A bulk make: its lines out of what's there (oldest first, freezer last), the shortfall
        noted for the list, and the pot into the fridge / dry shelf / freezer."""
        from . import nutrition
        for item in m["lines"]:
            ing = self.ings.get(item["ingredient_id"])
            if not ing:
                continue
            want = nutrition.qty_to_grams(ing, item["qty"], item["unit"]) or 0.0
            from . import forms
            take_id, want = forms.to_base(ing, want, self.ings)
            ing = self.ings.get(take_id, ing)
            have = sorted(lots.get(ing["id"], []), key=lambda l: (l["frozen"], l["since"]))
            for lot in have:
                take = min(lot["g"], want)
                lot["g"] -= take
                want -= take
                if want <= 0.5:
                    break
            if have:
                lots[ing["id"]] = [l for l in have if l["g"] > 0.5]
                if not lots[ing["id"]]:
                    lots.pop(ing["id"])
            if want > 0.5:
                short[ing["id"]] = short.get(ing["id"], 0.0) + want
        lots.setdefault(m["ingredient_id"], []).append(
            {"g": float(m["yield_g"]), "since": m["date"], "frozen": m["where"] == "freezer"})

    # looking ahead from the list week
    def outlook(self, week: str, ing_id: str, buy_g: float) -> dict:
        """Buy `buy_g` this week on top of what's there, then cook ahead. Says what's left after
        the week, how much of that the NEXT week cooks, how much of it ends up frozen or wasted
        (this week and next), and `runs_out`: the first week it has to be bought again
        (None = there's still some after PROJECT_WEEKS)."""
        lots = {ing_id: self.state(week).get(ing_id, [])}
        if buy_g:
            lots[ing_id].append({"g": buy_g, "since": week, "frozen": False})
        out = {"left_g": 0.0, "next_week_g": 0.0, "frozen_g": 0.0, "wasted_g": 0.0, "runs_out": None}
        for k in range(PROJECT_WEEKS):
            w = _add_days(week, 7 * k)
            want = self.cooks(w, week).get(ing_id, 0.0)
            before = self.total(lots.get(ing_id, []))
            tally: dict = {}
            self._cook_and_age(w, lots, {ing_id: want} if want else {}, tally)
            t = tally.get(ing_id, {})
            if k == 0:
                out["left_g"] = max(0.0, before - want)
            elif k == 1:
                out["next_week_g"] = min(before, want)
            if k <= 1:
                out["frozen_g"] += t.get("frozen", 0.0)
                out["wasted_g"] += t.get("wasted", 0.0)
            if t.get("short"):                  # ran out partway through this week
                out["runs_out"] = w
                break
            if not lots.get(ing_id):            # used up (or gone off) by the end of it
                out["runs_out"] = _add_days(w, 7)
                break
        return out

    def often(self, week: str, ing_id: str) -> bool:
        past = [_add_days(week, -7 * k) for k in range(1, USUAL_LOOKBACK + 1)]
        bought = sum(1 for w in past if self.weeks.get(w, {}).get("items", {}).get(ing_id, {}).get("checked"))
        planned_soon = any(self.needs(_add_days(week, 7 * k)).get(ing_id) for k in (1, 2))
        return bought >= OFTEN_WEEKS or planned_soon

    def bulk(self, week: str, ing_id: str, to_buy_g: float) -> Optional[dict]:
        """A bigger pack worth buying instead: cheaper per gram by BULK_MIN_SAVING, used within
        BULK_HORIZON_WEEKS (freezing what won't keep), and only for something bought often."""
        ing = self.ings.get(ing_id)
        pkg = self.best_package(week, ing_id, to_buy_g) or {}
        opts = (self.package(week, ing_id, chosen=False) or {}).get("options") or []
        if not ing or not to_buy_g or not pkg.get("package_g") or not pkg.get("price") or not opts:
            return None
        days, freezes = keeps(ing)
        if not (freezes or days >= 60) or not self.often(week, ing_id):
            return None
        per_g = pkg["price"] / pkg["package_g"]
        weekly = self.usual(week).get(ing_id) or self.needs(week).get(ing_id, 0.0)
        room = to_buy_g + weekly * (BULK_HORIZON_WEEKS - 1)
        best = None
        for o in opts:
            g, price = o.get("package_g"), o.get("price")
            if not g or not price or g <= pkg["package_g"] * 1.2 or g > room:
                continue
            if price / g > per_g * (1 - BULK_MIN_SAVING):
                continue
            saves = per_g * g - price
            if not best or saves > best["saves"]:
                best = {**o, "saves": round(saves, 2)}
        if best:
            # what the bigger pack turns into
            look = self.outlook(week, ing_id, best["package_g"])
            best["frozen_g"] = round(look["frozen_g"], 1)
            best["runs_out"] = look["runs_out"]
        return best

    def slot_sources(self, week: str) -> dict[str, dict]:
        """Where each planned meal's lines come from (Storm 2026-10-22: the lines should "say they
        are taking from the pantry or fridge or freezer"). The week's meals are walked in cooking
        order out of what's on hand at its start -- fridge/pantry before freezer, oldest first,
        the order the replay cooks in -- so the lines add up to the list beside them. Whatever
        stock can't cover is on the grocery or market list (`bought` once it's ticked off). A meal
        eaten from a batch put away (batches.py) says that instead of listing lines."""
        from . import batches, nutrition, recipes
        lots = self.state(week)
        shelf = batches.shelf()
        served, made = shelf.served_in(week), shelf.made_in(week)
        items = self.weeks.get(week, {}).get("items", {})
        rank = {m: i for i, m in enumerate(board.MEALS)}
        slots = board.get_week(week)["slots"]

        def when(key):
            d, m, i = board.parse_slot_key(key)
            return d, rank.get(m, 9), i

        out: dict[str, dict] = {}
        groups: set = set()
        for key in sorted(slots, key=when):
            slot, entry = slots[key], {}
            out[key] = entry
            if key in made:
                lot = made[key]
                st = slot.get("store") or {}
                entry["stored"] = {"n": st.get("n"), "where": lot["where"], "left": round(lot["n"], 2)}
            if key in served:
                entry["served"] = served[key]
                continue
            gid = slot.get("leftover_group")
            if gid:
                if gid in groups:
                    entry["leftovers"] = True
                    continue
                groups.add(gid)
            recipe = recipes.get(slot.get("recipe_id"))
            if recipe is None:
                continue
            lines: dict[str, dict] = {}
            for item in slot.get("ingredient_overrides") or recipe["ingredients"]:
                ing_id = item["ingredient_id"]
                ing = self.ings.get(ing_id)
                if ing is None:
                    continue
                want = nutrition.qty_to_grams(ing, item["qty"], item["unit"]) or 0.0
                have = sorted(lots.get(ing_id, []), key=lambda l: (l["frozen"], l["since"]))
                line = lines.setdefault(ing_id, {"from": {}, "short_g": 0.0})
                if want <= 0:
                    # no weight to count ("1 bunch"): it's either in the kitchen or it isn't
                    if have:
                        where = "freezer" if have[0]["frozen"] else storage(ing)
                        line["from"].setdefault(where, 0.0)
                    else:
                        line["short_g"] = line["short_g"] or 0.001
                    continue
                for lot in have:
                    take = min(lot["g"], want)
                    if take <= 0:
                        continue
                    lot["g"] -= take
                    want -= take
                    where = "freezer" if lot["frozen"] else storage(ing)
                    line["from"][where] = line["from"].get(where, 0.0) + take
                    if want <= 0.5:
                        break
                lots[ing_id] = [l for l in have if l["g"] > 0.5]
                if want > 0.5:
                    line["short_g"] += want
            for ing_id, line in lines.items():
                line["from"] = {w: round(g, 1) for w, g in line["from"].items()}
                line["from_text"] = {w: (w == "freezer" and blocks_text(self.ings[ing_id], g)) or made_text(self.ings[ing_id], g) or us_amount(g)
                                     for w, g in line["from"].items()}
                if line["short_g"]:
                    line["list"] = "make" if self.ings[ing_id].get("made") else self.list_of(week, ing_id)
                    line["bought"] = bool(items.get(ing_id, {}).get("checked"))
                    line["short_text"] = us_amount(line["short_g"])
                line["short_g"] = round(line["short_g"], 1)
            entry["lines"] = lines
        return out

    def on_hand(self, week: str) -> list[dict]:
        """Everything on hand at the start of the week, for the Pantry: where it is, how much,
        when it runs out (and whether that's soon), and by when the fresh part should be used."""
        from . import groceries
        listed = {i["ingredient_id"] for i in groceries.get_week_groceries(week, with_prices=False)
                  if not i.get("covered")}
        soon = _add_days(week, LOW_DAYS)
        out = []
        for ing_id, lots in self.state(week).items():
            ing = self.ings.get(ing_id)
            if not ing:
                continue
            days, freezes = keeps(ing)
            fresh = [l for l in lots if not l["frozen"]]
            fridge, frozen = self.total(fresh), self.total([l for l in lots if l["frozen"]])
            look = self.outlook(week, ing_id, 0.0)
            use_by = (min((_add_days(l["since"], days) for l in fresh), default=None)
                      if fresh and (not freezes or ing.get("made")) else None)
            out.append({"ingredient_id": ing_id, "name": ing["name"], "where": storage(ing),
                        "fridge_g": round(fridge, 1), "freezer_g": round(frozen, 1),
                        "fridge_text": pack_text(ing, fridge) or us_amount(fridge), "freezer_text": blocks_text(ing, frozen) or pack_text(ing, frozen) or us_amount(frozen),
                        "runs_out": look["runs_out"], "use_by": use_by,
                        # what this week's meals take, and what's left after them
                        "uses_g": round(max(0.0, fridge + frozen - look["left_g"]), 1),
                        "left_text": us_amount(look["left_g"]),
                        "low": bool(look["runs_out"] and look["runs_out"] <= soon),
                        "on_list": ing_id in listed, "keep_days": days, "freezes": freezes,
                        "made": bool(ing.get("made"))})
        out.sort(key=lambda r: (r["runs_out"] or "9999", r["name"].lower()))
        return out
