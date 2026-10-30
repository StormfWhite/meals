"""Recipes from the Notes app: the note's top line is the meal's name, every
line under it is one ingredient, and a leading amount ("2", "1 1/2 cups",
"1 kg / 2 lb") is the quantity -- the rest of the line is what to buy.

Written for the notes as they really are (Apple exports + the Notes app's
own Markdown), e.g.

    # Chicken shawarma
    * • 1 kg / 2 lb chicken thigh fillets , skinless and boneless (Note 3)
    Marinade
    * 1 large garlic clove , minced (or 2 small cloves)
    * Black pepper

When a note uses list bullets, only the bulleted lines are ingredients --
the bare lines between them ("Marinade", "Yoghurt Sauce") are sub-headings.
A bare line that starts with an amount ("½ cup strawberries", indented or
not) is an ingredient even in a bulleted note -- only amount-less bare lines
are sub-headings. A note with no bullets at all is one ingredient per line. Everything from a
"Method"/"Instructions" heading on is the recipe's notes, not ingredients.
A line with no amount is still an ingredient, just with no quantity: an
amount nobody wrote is never invented, and neither is a unit -- "2 eggs" is
2 of them, not 2 g.

Notes are read straight from the Notes app's folder (the laptop has it on
disk beside the meal data), or from a zip of it (the phone fetches one from
Dropbox -- see bridge.js).
"""
from __future__ import annotations

import os
import re
import zipfile
from pathlib import Path
from typing import Optional

from .paths import DATA_DIR

NOTES_DIR = Path(os.environ.get("MEALPLANNER_NOTES", DATA_DIR.parent / "notes"))
NOTES_ZIP = Path(os.environ.get("MEALPLANNER_NOTES_ZIP", "/notes.zip"))

UNITS = {
    "cup": "cup", "cups": "cup", "c": "cup",
    "tbsp": "tbsp", "tbs": "tbsp", "tablespoon": "tbsp", "tablespoons": "tbsp", "tbsps": "tbsp", "T": "tbsp",
    "tsp": "tsp", "teaspoon": "tsp", "teaspoons": "tsp", "tsps": "tsp", "t": "tsp",
    "g": "g", "gram": "g", "grams": "g", "gr": "g", "kg": "kg", "kilo": "kg", "kilos": "kg",
    "oz": "oz", "ounce": "oz", "ounces": "oz", "lb": "lb", "lbs": "lb", "pound": "lb", "pounds": "lb",
    "ml": "ml", "l": "l", "liter": "l", "liters": "l", "litre": "l", "litres": "l",
    "clove": "clove", "cloves": "clove", "can": "can", "cans": "can", "tin": "can", "tins": "can",
    "pinch": "pinch", "pinches": "pinch", "dash": "dash", "slice": "slice", "slices": "slice",
    "stick": "stick", "sticks": "stick", "bunch": "bunch", "bunches": "bunch", "head": "head", "heads": "head",
    "package": "package", "packages": "package", "pkg": "package", "jar": "jar", "jars": "jar",
    "handful": "handful", "handfuls": "handful", "sprig": "sprig", "sprigs": "sprig", "bag": "bag", "bags": "bag",
}
SIZES = {"large", "medium", "small", "big", "heaping", "heaped", "level", "scant"}
_VULGAR = {"½": .5, "⅓": 1 / 3, "⅔": 2 / 3, "¼": .25, "¾": .75, "⅕": .2, "⅛": .125, "⅜": .375, "⅝": .625, "⅞": .875}

_NUM = r"(?:\d+\s+\d+/\d+|\d+/\d+|\d+(?:\.\d+)?(?:\s*[½⅓⅔¼¾⅕⅛⅜⅝⅞])?|[½⅓⅔¼¾⅕⅛⅜⅝⅞])"
_AMOUNT = re.compile(rf"^(?P<num>{_NUM})(?:\s*(?:-|–|to)\s*{_NUM})?(?![\d/])\s*(?P<rest>.*)$")
_UNIT_WORD = re.compile(r"^([A-Za-z]+)\.?(?=\s|$|,)")
_TRAILING = re.compile(rf"^(?P<rest>.*\D)\s+(?P<num>{_NUM})\s*(?P<unit>[A-Za-z]+)?\.?$")
_BULLET = re.compile(r"^\s*(?:[-*+•◦▪‣▢☐□◻✓✔]|\d+[.)]|- \[[ xX]\]|\[[ xX]\])\s+")
_METHOD = re.compile(r"^(?:#+\s*)?(?:method|instructions?|directions?|steps?|preparation|prep|how to make( it)?|to make)\s*:?\s*$", re.I)
_JUNK = re.compile(r"^[\s\-—–*•▢☐□◻✓✔]*$")
_CHECKBOX_ONLY = re.compile(r"^\s*(?:[-*+•]\s*)?[▢☐□◻✓✔]\s*$")
_NUMBERED_HEAD = re.compile(r"^\d+\\?[.)]")                          # "2\. Balsamic Marinade" is a heading
_ING_HEAD = re.compile(r"^(?:#+\s*)?ingredients?\s*:?\s*$", re.I)


def _plain(line: str) -> str:
    """The Notes app's inline Markdown stripped back to the words."""
    line = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", line)          # [text](url)
    line = re.sub(r"==\w*:?(.*?)==", r"\1", line)                  # highlights
    line = re.sub(r"</?u>|\*\*|~~|`", "", line)
    line = re.sub(r"(?<!\w)_(.+?)_(?!\w)", r"\1", line)
    return line.strip()


def _number(tok: str) -> float:
    tok = tok.strip()
    if " " in tok and "/" in tok:                                  # "1 1/2"
        whole, frac = tok.split(None, 1)
        return float(whole) + _number(frac)
    if tok and tok[-1] in _VULGAR:                                 # "1½"
        head = tok[:-1].strip()
        return (float(head) if head else 0.0) + _VULGAR[tok[-1]]
    if "/" in tok:
        a, b = tok.split("/", 1)
        return float(a) / float(b) if float(b) else 0.0
    return float(tok)


def _unit(word: str) -> str:
    return UNITS.get(word) or UNITS.get(word.lower(), "")


WEIGHTS = {"g", "kg", "oz", "lb"}


def _unit_of(text: str) -> str:
    """The unit of a line that starts with an amount AND a unit ("2 tbsp oil"),
    else "" -- a bare number could be anything (a workout set, a date)."""
    m = _AMOUNT.match(text)
    if not m:
        return ""
    rest = re.sub(r"^\([^)]*\)\s*", "", m.group("rest"))
    word = _UNIT_WORD.match(rest)
    return _unit(word.group(1)) if word else ""


def _is_ingredient(text: str) -> bool:
    return bool(_unit_of(text))


def parse_line(line: str) -> Optional[dict]:
    """One ingredient line → {name, qty, unit, note}; qty None = no amount written."""
    text = _plain(_BULLET.sub("", _BULLET.sub("", line)))          # "* • 1 kg" has two bullets
    text = re.sub(r"^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)-(ounce|oz|pound|lb|gram|g)s?\b", r"\1 (\2 \3)", text)   # "1 15-ounce can"
    if not text:
        return None
    qty, unit = None, ""
    note_bits = []
    m = _AMOUNT.match(text)
    trail = None if m else _TRAILING.match(text)                    # "chicken 2 lb"
    if trail and (not trail.group("unit") or _unit(trail.group("unit"))):
        qty, unit = _number(trail.group("num")), _unit(trail.group("unit") or "") or ""
        text = trail.group("rest").rstrip(" -–:,")
    elif m:
        qty, rest = _number(m.group("num")), m.group("rest")
        size = re.match(r"^\(([^)]*)\)\s*", rest)                    # "1 (14 oz) can tomatoes"
        if size:
            note_bits.append(size.group(1))
            rest = rest[size.end():]
        word = _UNIT_WORD.match(rest)
        if word and _unit(word.group(1)):
            unit = _unit(word.group(1))
            rest = rest[word.end():].lstrip()
            # "1 kg / 2 lb chicken": the second amount says the same thing
            alt = re.match(rf"^(?:/|\(|or)\s*{_NUM}\s*[A-Za-z]*\.?\s*\)?\s*", rest)
            if alt:
                rest = rest[alt.end():]
        rest = re.sub(r"^of\s+", "", rest)
        text = rest
    words = text.split()
    while words and words[0].lower().strip(",") in SIZES:          # "1 large garlic clove"
        note_bits.append(words.pop(0).strip(","))
    text = " ".join(words)
    cut = re.search(r"\s*[,(;]|\s+-\s+", text)                     # "onion , diced" / "onion (red)"
    if cut and cut.start() > 0:
        note_bits.append(text[cut.start():].strip(" ,;-"))
        text = text[:cut.start()]
    name = text.strip(" .,:;-")
    if not name:
        return None
    return {"name": name, "qty": qty, "unit": unit, "note": " ".join(b for b in note_bits if b)}


def _body(raw: str) -> str:
    """A note file without its header block."""
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end >= 0:
            return raw[end + 4:].lstrip("\n")
    return raw


def parse_note(raw: str) -> dict:
    lines = _body(raw).replace("\r", "").split("\n")
    name, i = "", 0
    while i < len(lines) and not name:
        name = _plain(_BULLET.sub("", lines[i].lstrip("#").strip()))
        i += 1
    rest = lines[i:]
    # a note headed "Ingredients", or one that starts straight in with "2 cups
    # flour", has no meal name written -- leave it blank rather than call the
    # meal "Ingredients", and keep that first line as an ingredient
    if _ING_HEAD.match(name) or _CHECKBOX_ONLY.match(name):
        name = ""
    elif _is_ingredient(_plain(_BULLET.sub("", name))):
        rest, name = [lines[i - 1]] + rest, ""
    # a checklist note ("▢" boxes on their own lines, after or before each item): the boxes ARE the
    # bullets, so every line between them is an ingredient, amount or not ("Salt and pepper to taste")
    checklist = any(_CHECKBOX_ONLY.match(l) for l in rest)
    rest = [l for l in rest if not _JUNK.match(l)]
    bulleted = not checklist and any(_BULLET.match(l) for l in rest if l.strip())
    items, method = [], []
    for line in rest:
        if method or _METHOD.match(_plain(line)):
            method.append(line)
            continue
        if not line.strip() or _ING_HEAD.match(_plain(line)):
            continue
        if bulleted and not _BULLET.match(line) and not (_AMOUNT.match(_plain(line)) and not _NUMBERED_HEAD.match(_plain(line))):
            continue                                               # a sub-heading like "Marinade"; a line that
                                                                   # starts with an amount is always an ingredient
        item = parse_line(line)
        if item:
            items.append(item)
    return {"name": name, "ingredients": items, "notes": "\n".join(method[1:]).strip()}


# ── finding the notes ────────────────────────────────────────────────────

_cache: dict[str, tuple] = {}     # note id -> (stamp, title, score, modified, raw)


def _meta(raw: str) -> dict:
    head = {}
    if raw.startswith("---"):
        for line in raw[3:raw.find("\n---", 3)].splitlines():
            k, _, v = line.partition(":")
            head[k.strip()] = v.strip()
    return head


def _score(raw: str) -> int:
    """How much a note looks like a recipe: lines with an amount and a unit.
    A kitchen unit (cup, tbsp, clove) counts in full, a bare weight only a
    third -- "25 lb" is as likely a workout log as a shopping amount."""
    units = [_unit_of(_plain(_BULLET.sub("", _BULLET.sub("", l)))) for l in _body(raw).split("\n")]
    return round(sum(1 if u not in WEIGHTS else 1 / 3 for u in units if u))


def _title(raw: str) -> str:
    """The list's label for a note -- its first line, cheaply (no full parse
    of 3,000 notes just to draw a picker)."""
    for line in _body(raw).split("\n", 8)[:8]:
        t = _plain(_BULLET.sub("", line.lstrip("#").strip()))
        if t:
            return t[:90]
    return ""


def _files():
    """(id, stamp, reader) for every note, from the folder or the phone's zip."""
    if NOTES_DIR.is_dir():
        for p in NOTES_DIR.glob("*.md"):
            yield p.stem, p.stat().st_mtime, lambda p=p: p.read_text("utf-8", "replace")
    elif NOTES_ZIP.is_file():
        z = zipfile.ZipFile(NOTES_ZIP)
        for info in z.infolist():
            base = info.filename.rsplit("/", 1)[-1]
            if info.filename.count("/") <= 1 and base.endswith(".md"):
                yield base[:-3], info.date_time, lambda info=info: z.read(info).decode("utf-8", "replace")


def _all() -> list[tuple]:
    seen = set()
    for nid, stamp, read in _files():
        seen.add(nid)
        hit = _cache.get(nid)
        if not hit or hit[0] != stamp:
            raw = read()
            head = _meta(raw)
            if head.get("deleted") in ("1", "true"):
                _cache.pop(nid, None)
                seen.discard(nid)
                continue
            title = _title(raw)
            _cache[nid] = (stamp, title, _score(raw), int(head.get("modified") or 0), raw)
    for gone in set(_cache) - seen:
        _cache.pop(gone)
    return [(nid, *v) for nid, v in _cache.items()]


def available() -> bool:
    return NOTES_DIR.is_dir() or NOTES_ZIP.is_file()


def search(q: str = "", limit: int = 30) -> list[dict]:
    """Recipe-looking notes first; with a query, any note whose title or text has it."""
    q = q.strip().lower()
    rows = []
    for nid, _, title, score, modified, raw in _all():
        if not title:
            continue
        if q:
            in_title = q in title.lower()
            if not in_title and q not in raw.lower():
                continue
            rank = (in_title, score >= 4, modified)
        else:
            if score < 4:
                continue
            rank = (True, True, modified)
        rows.append((rank, {"id": nid, "title": title, "lines": score, "modified": modified}))
    rows.sort(key=lambda r: r[0], reverse=True)
    return [r[1] for r in rows[:limit]]


def note_recipe(note_id: str) -> Optional[dict]:
    _all()
    hit = _cache.get(note_id)
    return parse_note(hit[4]) if hit else None
