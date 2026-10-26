"""A photo of the fridge, the pantry shelf or the freezer -> rows for the Pantry to add.

Storm 2026-10-25: "take a picture and have it auto populate the data for the
freezer/pantry/fridge".

The split (code vs AI): the model only says what it SEES -- each food, how many of it, the size
printed on it (or its best guess), how full an opened one is, and where the picture looks like it
was taken. Everything else is code: the amount is built in the forms the Pantry already reads
("4 x 32 oz", "3", "2 bunch"), a name is tied to the catalog's ingredient only on an exact match
(the model is shown the catalog's names and asked to copy one when it's the same food), the same
food seen twice is one row, and the place picked in the Pantry beats the model's guess. Nothing is
added here: the rows come back to be checked and ticked in the Pantry first.

The model runs through StudyCode's model_manager in a subprocess (_ai_worker.py), so only the
laptop can do this; the phone asks the laptop through Dropbox (tools/scan_relay.py).
"""
from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Optional

from . import ingredients

STUDYCODE = Path(os.environ.get("MEALPLANNER_STUDYCODE", str(Path.home() / "Documents" / "StudyCode")))
WORKER = Path(__file__).with_name("_ai_worker.py")
TIMEOUT_S = 240
PLACES = ("fridge", "pantry", "freezer")
UNITS = {"can", "jar", "bag", "box", "bottle", "carton", "package", "tub", "tin", "pouch", "container",
         "bunch", "head", "block", "each", "loaf", "dozen", "stick", "bar"}

PROMPT = """\
This is a photo inside a home kitchen{place}. List every food or drink in it that someone would \
keep track of as groceries on hand.

Reply with ONLY a JSON object, no prose and no code fence:
{{"where": "fridge" | "pantry" | "freezer", "items": [{{"name": "...", "brand": "..." | null, "count": 1, "size": "32 oz" | null, \
"unit": "can" | "jar" | "bag" | "box" | "bottle" | "carton" | "package" | "tub" | "bunch" | "head" | \
"each" | null, "left": 1.0, "read": true}}]}}

- "where": where this photo looks like it was taken (a dry shelf or cupboard is "pantry").
- "name": the food as it would be written on a grocery list, WITHOUT the brand -- "black beans" \
(not "Goya black beans"), "penne", "greek yogurt", "frozen peas", "eggs". Only a product that IS its \
brand keeps it (e.g. "Olipop"). If one of these names already kept is the same food, copy it \
exactly: {known}
- "brand": the brand printed on it ("Goya", "Barilla"), else null.
- "count": how many separate identical containers or pieces you can see (4 cans = 4).
- "size": the amount ONE of them holds, as printed on the package ("32 oz", "1 lb", "500 g", \
"64 fl oz"). Not readable: your best estimate of a normal package of it, and "read": false. Loose \
produce with no package: null.
- "unit": what one of them is when there is no size (a bunch of cilantro, a head of lettuce, \
3 lemons = "each"); else the container word. Fruit and vegetables you can count one by one are \
"each" with "count" = how many pieces (a bunch of 6 bananas = count 6, "each"); "bunch" is only \
for herbs and greens sold tied together.
- "left": for an opened container, roughly how full it is (0.5 = half); 1.0 when unopened or unsure.
- Go shelf by shelf, then the door: jars, cheese, eggs, sauces and condiments count too. Name what \
the label or the look says it is ("canned chickpeas", "green olives"); a vague "canned food" only \
when nothing about it can be read.
- Only what you can actually see. Never invent items that might be behind others. Skip non-food \
(ice, ice packs, containers with nothing identifiable in them).
- Nothing recognisable: {{"where": "...", "items": []}}.
"""


def available() -> bool:
    py = STUDYCODE / ".venv" / "bin" / "python"
    return WORKER.exists() and py.exists() and (STUDYCODE / "model_manager.py").exists()


def _known_names() -> list[str]:
    names = sorted({i["name"] for i in ingredients.list_ingredients() if not i.get("made")}, key=str.lower)
    return names[:400]


def _ask(image: bytes, prompt: str, mime: str) -> str:
    import subprocess           # here, not at the top: the phone runs this package in the browser
    if not available():
        raise RuntimeError("the photo reader runs on the laptop (StudyCode's model_manager isn't here)")
    req = json.dumps({"prompt": prompt, "image_b64": base64.b64encode(image).decode(), "mime": mime})
    try:
        out = subprocess.run([str(STUDYCODE / ".venv" / "bin" / "python"), str(WORKER)], input=req,
                             capture_output=True, text=True, timeout=TIMEOUT_S, cwd=str(STUDYCODE))
    except subprocess.TimeoutExpired:
        raise RuntimeError("the photo took too long to read")
    for line in reversed(out.stdout.strip().splitlines()):
        if line.strip().startswith("{"):
            try:
                ans = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ans.get("ok"):
                return ans["text"]
            raise RuntimeError(ans.get("error") or "the model didn't answer")
    raise RuntimeError("the photo reader didn't answer" + (f" ({out.stderr.strip().splitlines()[-1][:160]})"
                                                           if out.stderr.strip() else ""))


def _json(text: str) -> Optional[dict]:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _num(v, default: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return n if n > 0 else default


def _fmt(n: float) -> str:
    return f"{round(n * 4) / 4:g}"


def _size(text) -> Optional[str]:
    """ "32 oz" / "32oz" / "1 lb." -> "32 oz"; anything the Pantry couldn't weigh -> None."""
    from . import stock
    t = str(text or "").strip().lower().replace("ounces", "oz").replace("ounce", "oz")
    if not t or not stock.size_g(t):
        return None
    return stock.size_text(t)


def qty_text(item: dict) -> str:
    """The amount in the words the Pantry's qty box takes (stock.text_to_g)."""
    count = _num(item.get("count"), 1.0)
    left = min(1.0, _num(item.get("left"), 1.0))
    size = _size(item.get("size"))
    unit = str(item.get("unit") or "").strip().lower()
    if unit == "bunch" and count > 3:
        unit = "each"        # "6 bunch" of bananas is 6 bananas: nobody keeps 6 bunches of cilantro
    if size:
        n = count * left
        return size if abs(n - 1) < 0.01 else f"{_fmt(n)} x {size}"
    n = count * left
    if unit in UNITS and unit not in ("each", "can", "jar", "bottle", "box", "carton", "package", "tub",
                                      "tin", "pouch", "container", "bag"):
        return f"{_fmt(n)} {unit}"
    return _fmt(n)


def _key(name: str) -> str:
    n = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    return re.sub(r"(ies|es|s)$", "", n)


def rows(data: dict, where: Optional[str]) -> list[dict]:
    """The model's items -> Pantry rows: catalog match by name, one row per food, a place each."""
    seen_where = data.get("where") if data.get("where") in PLACES else None
    by_key = {}
    for ing in ingredients.list_ingredients():
        by_key.setdefault(_key(ing["name"]), ing)
    out: dict[str, dict] = {}
    for item in data.get("items") or []:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()
        brand = re.sub(r"\s+", " ", str(item.get("brand") or "")).strip()
        if brand and name.lower().startswith(brand.lower() + " "):
            name = name[len(brand) + 1:]                    # "Goya black beans" -> "black beans"
        if not name or len(name) > 60:
            continue
        match = by_key.get(_key(name))
        k = match["id"] if match else _key(name)
        row = {"name": match["name"] if match else name, "ingredient_id": match["id"] if match else None,
               "qty": qty_text(item), "where": where or seen_where,
               "estimated": bool(_size(item.get("size"))) and item.get("read") is False}
        if k in out and re.fullmatch(r"[\d.]+", out[k]["qty"]) and re.fullmatch(r"[\d.]+", row["qty"]):
            out[k]["qty"] = _fmt(float(out[k]["qty"]) + float(row["qty"]))    # the same food seen twice
            continue
        while k in out:                                     # two sizes of it: a row each
            k += "+"
        out[k] = row
    return list(out.values())


def scan(image: bytes, where: Optional[str] = None, mime: str = "image/jpeg") -> dict:
    where = where if where in PLACES else None
    place = {"fridge": " (the fridge)", "pantry": " (a dry pantry shelf)", "freezer": " (the freezer)"}.get(where, "")
    known = ", ".join(f'"{n}"' for n in _known_names()) or "(none yet)"
    text = _ask(image, PROMPT.format(place=place, known=known), mime)
    data = _json(text)
    if data is None:
        raise RuntimeError("the model's answer wasn't readable")
    return {"where": where or (data.get("where") if data.get("where") in PLACES else None),
            "items": rows(data, where)}


def decode_image(data_url: str) -> tuple[bytes, str]:
    head, _, b64 = (data_url or "").partition(",")
    if not b64:
        head, b64 = "", data_url or ""
    mime = re.search(r"data:([\w/+.-]+)", head)
    return base64.b64decode(b64), (mime.group(1) if mime else "image/jpeg")
