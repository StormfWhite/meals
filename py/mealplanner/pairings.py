"""Which foods help or hinder each other's absorption, judged per meal by fixed rules.

Code decides every state (met / missing / blocked / tip) from the meal's real USDA numbers and
the words in its ingredient names; nothing here asks a model. The wording is written once.

kind: met = the helper is already in the meal; missing = the helper is absent (with owned foods
that would supply it, text only -- Storm: "no +, just the hint"); blocked = something in the
meal works against the nutrient; tip = a preparation habit, only shown in the popout.
Amounts are per portion (the pot over the meal's count).
"""
from __future__ import annotations

import datetime
import re
from typing import Optional

from . import ingredients, label, nutrition


def _rx(words: str) -> re.Pattern:
    return re.compile(r"\b(?:" + words + r")\b", re.I)


LEGUME = _rx(r"beans?|lentils?|chickpeas?|garbanzo|peas?|dal|dhal|edamame|soy|tofu|tempeh|hummus")
GRAIN = _rx(r"rice|oats?|oatmeal|quinoa|barley|farro|bulgur|wheat|millet|pasta|bread|couscous|polenta|cornmeal")
PHYTATE = _rx(r"beans?|lentils?|chickpeas?|garbanzo|dal|dhal|oats?|oatmeal|quinoa|barley|farro|bulgur|"
              r"whole wheat|brown rice|millet|almonds?|walnuts?|cashews?|seeds?|nuts?|sesame|tahini|bran")
PREPARED = _rx(r"soaked|sprouted|sourdough|tempeh|miso|fermented|natto")
INHIBITOR = _rx(r"tea|coffee|cocoa|cacao|matcha|chocolate|espresso")
ALLIUM = _rx(r"garlic|onions?|leeks?|shallots?|scallions?|chives")
OXALATE = _rx(r"spinach|chard|beet greens|rhubarb|sorrel")
FAT_SRC = _rx(r"oil|butter|ghee|avocados?|olives?|nuts?|almonds?|walnuts?|cashews?|pecans?|pistachios?|"
              r"seeds?|tahini|cheese|egg|eggs|cream|coconut|peanut|yogurt|hummus|tofu")
PEPPER = _rx(r"black pepper|peppercorns?|pepper, black")
TOMATO = _rx(r"tomato(?:es)?|marinara|passata")
CRUCIFER = _rx(r"broccoli|cauliflower|kale|cabbage|brussels sprouts?|bok choy|collards?|kohlrabi")
PUNGENT = _rx(r"mustard|radish|arugula|wasabi|horseradish|watercress")
FLAX = _rx(r"flax|flaxseeds?|linseeds?")
GROUND = _rx(r"ground|meal|milled")
TURMERIC = _rx(r"turmeric|curcuma")
C_FOOD_NAMES = _rx(r"lemons?|limes?|oranges?|peppers?|tomato(?:es)?|strawberr\w+|kiwi\w*|broccoli|guava|"
                   r"cabbage|grapefruit|mango|papaya|pineapple")

IRON_MIN = 1.5      # mg per portion before an iron pairing is worth a line
C_ENOUGH = 25       # mg vitamin C in the meal that lifts plant-iron absorption
CA_BLOCKS = 300     # mg calcium in one meal that starts to compete with iron
A_MIN = 150         # mcg vitamin A per portion before fat matters
FAT_ENOUGH = 5      # g fat in the meal for A / E / K / carotenoids
PROTEIN_ZN = 15


class _Item:
    __slots__ = ("id", "name", "grams", "per100", "cat")

    def __init__(self, ing, grams, per100):
        self.id, self.name, self.grams, self.per100 = ing["id"], ing["name"], grams, per100
        self.cat = (per100.get("food_category") or "")

    def amount(self, key: str, f: float = 1.0) -> Optional[float]:
        a = label.amount_of(self.per100, key)
        return None if a is None else a * self.grams / 100.0 * f


class _Meal:
    def __init__(self, lines: list[dict], servings: Optional[float], n_people: int):
        self.f = label.portion_factor(servings, n_people)
        self.items: list[_Item] = []
        for ln in lines or []:
            ing = ingredients.get(ln.get("ingredient_id") or "")
            if not ing:
                continue
            per100 = nutrition.nutrients_per_100g(ing)
            grams = nutrition.qty_to_grams(ing, ln.get("qty") or 0, ln.get("unit") or "") if ln.get("qty") else None
            if per100 and grams:
                self.items.append(_Item(ing, grams, per100))
            else:                                  # unweighed lines still count for word rules
                self.items.append(_Item(ing, 0.0, per100 or {}))

    def total(self, key: str) -> float:
        return sum((it.amount(key, self.f) or 0.0) for it in self.items)

    def named(self, rx: re.Pattern) -> list[_Item]:
        return [i for i in self.items if rx.search(i.name)]

    def ids(self, items) -> list[str]:
        return [i.id for i in items]

    def top(self, key: str, n: int = 2) -> list[_Item]:
        got = [(i.amount(key, self.f) or 0.0, i) for i in self.items]
        return [i for a, i in sorted(got, key=lambda t: -t[0])[:n] if a > 0]

    def has_fat(self) -> bool:
        known = [i.amount("fat_g", self.f) for i in self.items]
        if any(a is not None for a in known):
            return sum(a or 0 for a in known) >= FAT_ENOUGH
        return bool(self.named(FAT_SRC))          # older USDA rows: judge by the words


def _helpers(owned: list[dict], exclude: set, key: Optional[str] = None, rx: Optional[re.Pattern] = None,
             min_amount: float = 0.0, n: int = 3) -> list[str]:
    """Names of foods already bought that would supply the missing piece, best first."""
    out = []
    for o in owned:
        if o["ingredient_id"] in exclude:
            continue
        if rx is not None:
            if not rx.search(o["name"]):
                continue
            score = 1.0
        else:
            a = label.amount_of(o["per100"], key)
            score = (a or 0) * o["grams"] / 100.0
            if score < min_amount:
                continue
        out.append((score, o["name"]))
    out.sort(key=lambda t: -t[0])
    seen, names = set(), []
    for _, name in out:
        if name.lower() not in seen:
            seen.add(name.lower())
            names.append(name)
    return names[:n]


def _p(id_, kind, line, detail, about, helpers=None) -> dict:
    return {"id": id_, "kind": kind, "line": line, "detail": detail, "about": about, "helpers": helpers or []}


def for_meal(lines: list[dict], servings: Optional[float] = None, n_people: int = 1,
             owned: Optional[list[dict]] = None, today: Optional[datetime.date] = None) -> list[dict]:
    """The pairings for one meal's lines, [{id, kind, line, detail, about, helpers}]."""
    m = _Meal(lines, servings, n_people)
    if not m.items:
        return []
    if owned is None:
        from . import gaps
        owned = gaps._owned(today or datetime.date.today())
    here = {i.id for i in m.items}
    out: list[dict] = []

    iron, zinc, calcium = m.total("iron_mg"), m.total("zinc_mg"), m.total("calcium_mg")
    vitc, protein = m.total("vitamin_c_mg"), m.total("protein_g")
    iron_items = m.top("iron_mg")

    # 1. plant iron x vitamin C
    if iron >= IRON_MIN and iron_items:
        about = m.ids(iron_items)
        if vitc >= C_ENOUGH:
            out.append(_p("iron_c", "met", f"Iron + vitamin C: {round(vitc)} mg C in this meal",
                          "Vitamin C turns plant (non-heme) iron into a form the gut takes up and keeps it "
                          "soluble. Around 25-100 mg of C eaten in the same meal roughly doubles to triples "
                          "how much plant iron is absorbed.", about))
        else:
            out.append(_p("iron_c", "missing", f"Iron {iron:.1f} mg but little vitamin C ({round(vitc)} mg)",
                          "Plant iron is absorbed poorly alone (about 2-10%). Vitamin C in the same meal turns "
                          "it into a more absorbable form and roughly doubles to triples uptake. A squeeze of "
                          "lemon, raw bell pepper, tomato or a few strawberries is enough; it has to be in the "
                          "same meal, not later in the day.", about,
                          _helpers(owned, here, "vitamin_c_mg", min_amount=15)))

    # 2. iron vs calcium
    if iron >= IRON_MIN and calcium >= CA_BLOCKS:
        ca_items = m.top("calcium_mg")
        out.append(_p("iron_ca", "blocked", f"Calcium {round(calcium)} mg competes with iron",
                      "Calcium and iron share an absorption route, and a meal with 300 mg or more of calcium "
                      "lowers iron uptake noticeably. Moving the dairy or calcium-set tofu to another meal, "
                      "or the iron-rich food to one without it, keeps both.", m.ids(iron_items) + m.ids(ca_items)))

    # 3. tea / coffee / cocoa against iron and zinc
    inhib = m.named(INHIBITOR)
    if inhib and (iron >= 0.8 or zinc >= 1.0 or m.named(PHYTATE)):
        out.append(_p("polyphenols", "blocked", "Tea, coffee or cocoa binds iron and zinc",
                      "Polyphenols and tannins bind iron and zinc in the gut; a cup of tea or coffee with a "
                      "meal can cut plant-iron absorption by well over a third. About an hour apart from "
                      "the meal avoids most of it.", m.ids(inhib) + m.ids(iron_items)))

    # 4. phytate in legumes, whole grains, nuts and seeds
    phy = m.named(PHYTATE)
    if phy:
        done = [i for i in phy if PREPARED.search(i.name)]
        if len(done) == len(phy):
            out.append(_p("phytate", "met", "Soaked, sprouted or fermented: less phytate",
                          "Phytate in legumes, whole grains, nuts and seeds binds iron and zinc. Soaking, "
                          "sprouting and fermenting (sourdough, tempeh, miso) break part of it down.", m.ids(phy)))
        else:
            out.append(_p("phytate", "tip", "Phytate holds back iron and zinc in beans, grains, nuts",
                          "Soaking beans and grains overnight (and discarding the water), sprouting, or choosing "
                          "sourdough, tempeh and miso breaks down part of the phytate that binds iron and zinc. "
                          "Cooking from dry with a long simmer, and vitamin C in the same meal, also help.",
                          m.ids([i for i in phy if i not in done])))

    # 5. onion family with iron / zinc foods
    allium = m.named(ALLIUM)
    if allium and (iron >= IRON_MIN or zinc >= 1.5):
        out.append(_p("allium", "met", "Garlic or onion alongside iron and zinc",
                      "Garlic and onion appear to improve iron and zinc uptake from grains and legumes, a "
                      "modest effect but a free one.", m.ids(allium) + m.ids(iron_items)))

    # 6. oxalate
    ox = m.named(OXALATE)
    if ox:
        out.append(_p("oxalate", "tip", "Oxalate in this green locks up its own calcium and iron",
                      "Spinach, chard, beet greens and rhubarb hold most of their calcium and iron bound to "
                      "oxalate, so far less is absorbed than the label says. Kale, bok choy, collards and "
                      "broccoli carry calcium that is absorbed far better. Boiling spinach and discarding the "
                      "water removes part of the oxalate.", m.ids(ox)))

    # 7. fat-soluble vitamins and carotenoids
    a_items = [i for i in m.items if (i.amount("vitamin_a_mcg", m.f) or 0) >= A_MIN * 0.5
               or (i.amount("vitamin_k_mcg", m.f) or 0) >= 40 or (i.amount("vitamin_e_mg", m.f) or 0) >= 3
               or (i.amount("beta_carotene_mcg", m.f) or 0) >= 1000]
    if m.total("vitamin_a_mcg") >= A_MIN or any((i.amount("vitamin_k_mcg", m.f) or 0) >= 40 for i in m.items):
        if m.has_fat():
            out.append(_p("fat_soluble", "met", "Vitamins A, E, K and carotenoids have fat to ride on",
                          "Vitamins A, E, K and carotenoids (carrots, sweet potato, greens, tomatoes) dissolve "
                          "in fat, not water. A few grams of fat in the same meal can raise their absorption "
                          "several-fold.", m.ids(a_items or m.top("vitamin_a_mcg"))))
        else:
            out.append(_p("fat_soluble", "missing", "Fat-soluble vitamins with almost no fat in the meal",
                          "Vitamins A, E, K and carotenoids (carrots, sweet potato, greens, tomatoes) dissolve "
                          "in fat, not water. Without about 3-5 g of fat in the same meal much of them passes "
                          "through; a spoon of oil, some avocado, nuts, seeds or cheese is enough.",
                          m.ids(a_items or m.top("vitamin_a_mcg")), _helpers(owned, here, rx=FAT_SRC)))

    # 8. calcium needs vitamin D over time
    ca_lines = [i for i in m.items if (i.amount("calcium_mg", m.f) or 0) >= 100]
    if ca_lines:
        out.append(_p("calcium_d", "tip", "Calcium absorption leans on vitamin D",
                      "Vitamin D raises calcium absorption in the gut. It works over the days, not the meal: "
                      "sun, fortified milks or mushrooms exposed to UV, and a supplement in winter are what "
                      "count. Magnesium and vitamin K help calcium end up in bone.", m.ids(ca_lines)))

    # 9. zinc with protein
    if zinc >= 1.5 and protein >= PROTEIN_ZN:
        out.append(_p("zinc_protein", "met", f"Zinc with {round(protein)} g protein",
                      "Amino acids (especially cysteine and histidine) keep zinc soluble and help it cross "
                      "the gut wall, so zinc from beans, seeds and grains is absorbed better in a meal with "
                      "real protein.", m.ids(m.top("zinc_mg"))))

    # 10. legumes + grains
    leg, gr = m.named(LEGUME), m.named(GRAIN)
    if leg and gr:
        out.append(_p("complement", "met", "Legumes with grains complete each other",
                      "Legumes are short in methionine and rich in lysine; grains are the reverse. Together "
                      "they supply every essential amino acid. Eating both within the same day is enough, "
                      "they do not need to share a plate.", m.ids(leg) + m.ids(gr)))
    elif leg or gr:
        which, other = ("legumes", "a grain") if leg else ("grains", "a legume")
        out.append(_p("complement", "tip", f"Pair {which} with {other} sometime today",
                      "Grains are short in lysine and legumes in methionine. Having both over the day, not "
                      "necessarily in one meal, covers all the essential amino acids.", m.ids(leg or gr)))

    # 11. turmeric + black pepper (+ fat)
    tur = m.named(TURMERIC)
    if tur:
        if m.named(PEPPER) and m.has_fat():
            out.append(_p("turmeric", "met", "Turmeric with black pepper and fat",
                          "Curcumin is poorly absorbed by itself. Piperine in black pepper slows its breakdown "
                          "in the liver (reported increases are as large as 20-fold in one study), and fat "
                          "carries it across the gut.", m.ids(tur)))
        else:
            need = []
            if not m.named(PEPPER):
                need.append("black pepper")
            if not m.has_fat():
                need.append("a little fat")
            out.append(_p("turmeric", "missing", f"Turmeric wants {' and '.join(need)}",
                          "Curcumin is poorly absorbed by itself. Piperine in black pepper slows its breakdown "
                          "in the liver (reported increases are as large as 20-fold in one study), and fat "
                          "carries it across the gut. A few grinds of pepper and a little oil is the usual fix.",
                          m.ids(tur), _helpers(owned, here, rx=FAT_SRC, n=2) if not m.has_fat() else []))

    # 12. tomato + fat (lycopene), better cooked
    tom = m.named(TOMATO)
    if tom:
        if m.has_fat():
            out.append(_p("lycopene", "met", "Tomato with fat: lycopene absorbs",
                          "Lycopene is fat-soluble and sits locked in the cell walls. Cooking releases it, "
                          "and fat in the same meal can multiply absorption several times over.", m.ids(tom)))
        else:
            out.append(_p("lycopene", "missing", "Tomato with no fat in the meal",
                          "Lycopene is fat-soluble and sits locked in the cell walls. Cooking releases it, "
                          "and fat in the same meal (olive oil, avocado, cheese) can multiply absorption "
                          "several times over.", m.ids(tom), _helpers(owned, here, rx=FAT_SRC)))

    # 13. garlic rest
    gar = m.named(_rx(r"garlic"))
    if gar:
        out.append(_p("garlic_rest", "tip", "Chop or crush garlic, then wait about 10 minutes",
                      "Crushing lets the enzyme alliinase make allicin, the compound behind garlic's "
                      "effects. Heat destroys the enzyme, so letting it sit for about 10 minutes before it "
                      "meets the pan keeps more of it.", m.ids(gar)))

    # 14. cruciferous sulforaphane
    cru = m.named(CRUCIFER)
    if cru:
        if m.named(PUNGENT):
            out.append(_p("sulforaphane", "met", "Crucifer with a source of active myrosinase",
                          "Heat inactivates myrosinase, the enzyme that makes sulforaphane from cabbage-family "
                          "vegetables. Mustard, radish or arugula in the meal supplies a working one.",
                          m.ids(cru)))
        else:
            out.append(_p("sulforaphane", "tip", "Crucifers: chop and rest, or add mustard seed",
                          "Chopping and waiting about 40 minutes before cooking lets myrosinase make "
                          "sulforaphane, and a pinch of ground mustard seed or some raw radish or arugula "
                          "restores it when the vegetable is fully cooked. Light steaming (3-4 minutes) "
                          "keeps more than boiling.", m.ids(cru)))

    # 15. flax
    fl = [i for i in m.named(FLAX) if not GROUND.search(i.name)]
    if fl:
        out.append(_p("flax", "tip", "Whole flaxseed passes through; grind it",
                      "The hull of whole flaxseed resists digestion, so most of its omega-3 and lignans leave "
                      "unabsorbed. Ground flax (or flax meal) is absorbed; store it in the fridge since "
                      "the oil goes rancid.", m.ids(fl)))

    order = {"blocked": 0, "missing": 1, "met": 2, "tip": 3}
    out.sort(key=lambda p: order[p["kind"]])
    return out
