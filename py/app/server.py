"""FastAPI backend for the Meal Planner desktop app.

Route handlers stay thin -- response shaping only, business logic lives in
the `mealplanner` package -- same division Price Hunt draws between
app/server.py and pricehunt/*.py. Phase 0 wires up just enough to serve
the static shell and prove the install/launch path works; each later
phase adds its own route group here as the matching mealplanner/*.py
module lands.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from mealplanner import (bangers, aisles, board, config, fdc, groceries, household, ingredients,
                         learning, nutrition, places, prices, recipe_import, recipes, routines, stats, stock,
                         suggest)
from mealplanner.paths import ensure_dirs

WEB_DIR = Path(__file__).parent / "web"

ensure_dirs()

app = FastAPI(title="Meal Planner")


@app.get("/api/meta")
def meta():
    cfg = config.load()
    place = places.active()
    return {
        "app": "Meal Planner",
        "reup_day": cfg["reup_day"],
        "fdc_key_set": config.fdc_key_set(),
        "kroger_key_set": prices.kroger_configured(),
        "kroger_problem": prices.kroger_problem(),
        "place": place,
    }


# ── config ───────────────────────────────────────────────────────────────

class ConfigBody(BaseModel):
    reup_day: Optional[str] = None
    usda_fdc_api_key: Optional[str] = None
    kroger_client_id: Optional[str] = None
    kroger_client_secret: Optional[str] = None


def _config_view(cfg: dict) -> dict:
    return {"reup_day": cfg["reup_day"], "fdc_key_set": bool(cfg["usda_fdc_api_key"]),
            "kroger_key_set": bool(cfg["kroger_client_id"] and cfg["kroger_client_secret"])}


@app.get("/api/config")
def get_config():
    return _config_view(config.load())


@app.post("/api/config")
def put_config(body: ConfigBody):
    return _config_view(config.save(body.model_dump(exclude_none=True)))


# ── places & stores ──────────────────────────────────────────────────────

class PlaceBody(BaseModel):
    label: str
    lat: float
    lon: float
    address: str = ""


class PlaceUpdateBody(BaseModel):
    label: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    address: Optional[str] = None
    store: Optional[dict] = None
    market: Optional[dict] = None


@app.get("/api/places")
def get_places():
    return {"places": places.list_places(), "active": places.active()}


@app.post("/api/places")
def create_place(body: PlaceBody):
    return {"place": places.add_place(body.label, body.lat, body.lon, body.address),
            "places": places.list_places()}


@app.put("/api/places/{place_id}")
def put_place(place_id: str, body: PlaceUpdateBody):
    try:
        place = places.update_place(place_id, **body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, "no such place")
    return {"place": place, "places": places.list_places()}


@app.post("/api/places/{place_id}/active")
def activate_place(place_id: str):
    try:
        return {"active": places.set_active(place_id)}
    except KeyError:
        raise HTTPException(404, "no such place")


@app.delete("/api/places/{place_id}")
def remove_place(place_id: str):
    if not places.delete_place(place_id):
        raise HTTPException(404, "no such place")
    return {"places": places.list_places(), "active": places.active()}


@app.get("/api/places/search")
def search_places(q: str):
    return {"results": places.search_places(q)}


@app.get("/api/stores/search")
def search_stores(q: str = "", kind: str = "grocery", place_id: Optional[str] = None,
                  refresh: bool = False, lat: Optional[float] = None, lon: Optional[float] = None):
    """Type-to-filter over real shops near the active place -- or near the phone's current
    position (`lat`/`lon`, places.spot_for). `refresh` re-fetches from OpenStreetMap;
    ordinary typing never touches the network (see places.py)."""
    if lat is not None and lon is not None and not place_id:
        slat, slon, label = places.spot_for(lat, lon)
        if refresh:
            places.stores_near(slat, slon, kind, refresh=True)
        return {"results": places.search_stores(q, slat, slon, kind),
                "place": {"id": None, "label": label}}
    place = next((p for p in places.list_places() if p["id"] == place_id), None) if place_id else places.active()
    if place is None:
        raise HTTPException(400, "add a place first — a store list needs somewhere to be near")
    if refresh:
        places.stores_near(place["lat"], place["lon"], kind, refresh=True)
    return {"results": places.search_stores(q, place["lat"], place["lon"], kind),
            "place": {"id": place["id"], "label": place["label"]}}


# ── household ────────────────────────────────────────────────────────────

class TargetsBody(BaseModel):
    calories_kcal: float = 2000
    protein_g: float = 50
    fiber_g: float = 28
    vitamins: dict = {}


class MemberBody(BaseModel):
    name: str
    targets: Optional[TargetsBody] = None


class MemberUpdateBody(BaseModel):
    name: Optional[str] = None
    targets: Optional[TargetsBody] = None
    active: Optional[bool] = None


@app.get("/api/household/members")
def get_members():
    return {"members": household.list_members()}


@app.post("/api/household/members")
def create_member(body: MemberBody):
    if not body.name.strip():
        raise HTTPException(400, "a household member needs a name")
    targets = body.targets.model_dump() if body.targets else None
    member = household.add_member(body.name, targets)
    return {"member": member, "members": household.list_members()}


@app.put("/api/household/members/{member_id}")
def put_member(member_id: str, body: MemberUpdateBody):
    try:
        targets = body.targets.model_dump() if body.targets else None
        member = household.update_member(member_id, name=body.name, targets=targets, active=body.active)
    except KeyError:
        raise HTTPException(404, "no such household member")
    return {"member": member, "members": household.list_members()}


@app.delete("/api/household/members/{member_id}")
def remove_member(member_id: str):
    if not household.delete_member(member_id):
        raise HTTPException(404, "no such household member")
    return {"members": household.list_members()}


# ── ingredients ──────────────────────────────────────────────────────────

class IngredientBody(BaseModel):
    name: str
    category: str = "other"
    default_unit: str = "g"
    unit_conversions: dict = {}
    store_section: Optional[str] = None
    manual_nutrients: Optional[dict] = None
    resolve: bool = True     # False: just make it, the USDA match follows in the background


class IngredientUpdateBody(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    default_unit: Optional[str] = None
    unit_conversions: Optional[dict] = None
    store_section: Optional[str] = None
    manual_nutrients: Optional[dict] = None
    fdc_id: Optional[int] = None
    freezes: Optional[bool] = None     # overrides stock.keeps' guess
    keep_days: Optional[int] = None


@app.get("/api/ingredients")
def get_ingredients(q: Optional[str] = None):
    return {"ingredients": ingredients.list_ingredients(q)}


@app.get("/api/ingredients/fdc-search")
def fdc_search(q: str):
    if not fdc.available():
        raise HTTPException(400, "no USDA FoodData Central API key set — add one in Settings")
    if not q.strip():
        return {"results": []}
    return {"results": fdc.search(q)}


@app.post("/api/ingredients")
def create_ingredient(body: IngredientBody):
    """Every ingredient anyone types anywhere arrives here, so this is
    where it's made real: bound to its USDA food, which brings the
    nutrients, the portion table that makes "1/2 cup" weighable, and the
    category that decides which shopping list it lands on. Best-effort --
    an ingredient with no confident match still plans and shops fine."""
    if not body.name.strip():
        raise HTTPException(400, "an ingredient needs a name")
    ing = ingredients.add(body.name, body.category, body.default_unit,
                          body.unit_conversions, body.store_section, body.manual_nutrients)
    if body.resolve:
        try:
            ing = ingredients.resolve_usda(ing["id"]) or ing
        except Exception:
            pass
    return {"ingredient": ing}


@app.put("/api/ingredients/{ingredient_id}")
def put_ingredient(ingredient_id: str, body: IngredientUpdateBody):
    try:
        ing = ingredients.update(ingredient_id, **body.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, "no such ingredient")
    return {"ingredient": ing}


class ShopListBody(BaseModel):
    shop_list: str


@app.post("/api/ingredients/{ingredient_id}/shop-list")
def set_shop_list(ingredient_id: str, body: ShopListBody):
    """Move an item between the grocery list and the farmer's market. An
    explicit move is remembered as a decision (see aisles.py) and never
    re-derived."""
    if body.shop_list not in (aisles.GROCERY, aisles.MARKET):
        raise HTTPException(400, "shop_list must be 'grocery' or 'market'")
    try:
        ing = ingredients.update(ingredient_id, shop_list=body.shop_list)
    except KeyError:
        raise HTTPException(404, "no such ingredient")
    return {"ingredient": ing}


@app.post("/api/ingredients/{ingredient_id}/resolve")
def resolve_ingredient(ingredient_id: str, force: bool = False, js_fetch: bool = False):
    """Bind one ingredient to its USDA food (and take the portions and
    category with it). `js_fetch` (the phone, see fdc.JS_RESPONSES): a
    USDA answer not fetched yet comes back as 202 {"need": url}."""
    if not fdc.available():
        raise HTTPException(400, "no USDA FoodData Central API key set — add one in Settings")
    if js_fetch:
        fdc.JS_RESPONSES = fdc.JS_STORE
    try:
        ing = ingredients.resolve_usda(ingredient_id, force=force)
    except fdc.NeedFetch as need:
        return JSONResponse({"need": need.url}, status_code=202)
    except KeyError:
        raise HTTPException(404, "no such ingredient")
    finally:
        fdc.JS_RESPONSES = None
    if ing is None:
        raise HTTPException(404, "no confident USDA match for that name")
    return {"ingredient": ing}


@app.post("/api/ingredients/resolve-all")
def resolve_all_ingredients(force: bool = False):
    """Catch up everything typed before auto-matching existed."""
    if not fdc.available():
        raise HTTPException(400, "no USDA FoodData Central API key set — add one in Settings")
    matched, missed = [], []
    for ing in ingredients.list_ingredients():
        if ing.get("fdc_id") and not force:
            continue
        try:
            resolved = ingredients.resolve_usda(ing["id"], force=force)
        except Exception:
            resolved = None
        (matched if resolved else missed).append(ing["name"])
    return {"matched": matched, "unmatched": missed,
            "ingredients": ingredients.list_ingredients()}


@app.delete("/api/ingredients/{ingredient_id}")
def remove_ingredient(ingredient_id: str):
    if not ingredients.delete(ingredient_id):
        raise HTTPException(404, "no such ingredient")
    return {"ok": True}


# ── recipes ──────────────────────────────────────────────────────────────

class RecipeIngredient(BaseModel):
    ingredient_id: str
    qty: float
    unit: str
    note: str = ""  # free-text per-line note ("very ripe", "from the market") — never parsed


class RecipeBody(BaseModel):
    name: str
    servings: int = 1
    ingredients: list[RecipeIngredient] = []
    tags: list[str] = []
    notes: str = ""


class RecipeUpdateBody(BaseModel):
    name: Optional[str] = None
    servings: Optional[int] = None
    ingredients: Optional[list[RecipeIngredient]] = None
    tags: Optional[list[str]] = None
    notes: Optional[str] = None
    hide_suggest: Optional[bool] = None  # removed from the meal-name dropdown


def _recipe_summary(recipe: dict, ing_by_id: dict) -> dict:
    totals = nutrition.recipe_totals(recipe, ing_by_id)
    return {**recipe, "nutrition_per_serving": totals["per_serving"],
            "unknown_ingredients": totals["unknown_ingredients"]}


@app.get("/api/recipes")
def get_recipes():
    ing_by_id = ingredients.by_id()
    return {"recipes": [_recipe_summary(r, ing_by_id) for r in recipes.list_recipes()]}


@app.post("/api/recipes")
def create_recipe(body: RecipeBody):
    if not body.name.strip():
        raise HTTPException(400, "a recipe needs a name")
    recipe = recipes.add(body.name, body.servings,
                         [i.model_dump() for i in body.ingredients], body.tags, body.notes)
    return {"recipe": _recipe_summary(recipe, ingredients.by_id())}


# ── recipes from the Notes app ─────────────────────────────────────────────

class RecipeTextBody(BaseModel):
    text: str


@app.get("/api/notes")
def find_notes(q: str = ""):
    """Notes to import a recipe from: recipe-looking ones first."""
    return {"available": recipe_import.available(), "notes": recipe_import.search(q)}


@app.get("/api/notes/{note_id}/recipe")
def note_as_recipe(note_id: str):
    parsed = recipe_import.note_recipe(note_id)
    if parsed is None:
        raise HTTPException(404, "no such note")
    return parsed


@app.post("/api/recipes/parse")
def parse_recipe_text(body: RecipeTextBody):
    """Pasted text, read the same way a note is: top line = name, one ingredient a line."""
    return recipe_import.parse_note(body.text)


@app.put("/api/recipes/{recipe_id}")
def put_recipe(recipe_id: str, body: RecipeUpdateBody):
    fields = body.model_dump(exclude_none=True)
    if "ingredients" in fields:
        fields["ingredients"] = [dict(i) for i in fields["ingredients"]]
    try:
        recipe = recipes.update(recipe_id, **fields)
    except KeyError:
        raise HTTPException(404, "no such recipe")
    return {"recipe": _recipe_summary(recipe, ingredients.by_id())}


@app.delete("/api/recipes/{recipe_id}")
def remove_recipe(recipe_id: str):
    if not recipes.delete(recipe_id):
        raise HTTPException(404, "no such recipe")
    return {"ok": True}


@app.get("/api/recipes/{recipe_id}/nutrition")
def recipe_nutrition(recipe_id: str):
    recipe = recipes.get(recipe_id)
    if recipe is None:
        raise HTTPException(404, "no such recipe")
    return nutrition.recipe_totals(recipe, ingredients.by_id())


# ── board ────────────────────────────────────────────────────────────────

class SlotBody(BaseModel):
    recipe_id: str
    servings_used: float = 1
    ingredient_overrides: Optional[list[RecipeIngredient]] = None


class LinkBody(BaseModel):
    slot_a: str
    slot_b: str


@app.get("/api/board")
def get_board(week: Optional[str] = None):
    week_start = week or board.current_week_start()
    return board.get_week(week_start)


@app.get("/api/board/day/{date}")
def get_board_day(date: str):
    # `list_week` / `market_week`: the weeks the two lists are for (Monday / after that list's shop)
    # (the grocery list and the farmer's market list move on separately)
    return {**board.day_slots(date), "list_week": groceries.list_week(kind="grocery"),
            "market_week": groceries.list_week(kind="market")}


class HereBody(BaseModel):
    lat: float
    lon: float


@app.post("/api/places/here")
def phone_is_here(body: HereBody):
    """The phone's position: switches the active home when it's near another saved one."""
    switched = places.arrived(body.lat, body.lon)
    return {"switched": bool(switched), "active": switched or places.active()}


@app.get("/api/groceries/geofences")
def get_geofences(lat: Optional[float] = None, lon: Optional[float] = None):
    """Grocery stores + markets near home -- and near where the phone is, when that's elsewhere --
    for the Pixel to notice a shopping trip."""
    return {"fences": groceries.geofences(lat, lon)}


@app.get("/api/board/meal-options")
def get_board_meal_options(meal: str):
    if meal not in board.MEALS:
        raise HTTPException(400, "meal must be breakfast, lunch, or dinner")
    out = []
    for opt in board.meal_options(meal):
        recipe = recipes.get(opt["recipe_id"])
        if recipe is None or recipe.get("hide_suggest"):
            continue
        out.append({**opt, "name": recipe["name"]})
    return {"options": out}


@app.get("/api/suggest/ingredients")
def suggest_ingredients(q: str = "", meal: Optional[str] = None, meal_name: str = "",
                        used: str = "", limit: int = 8, week: Optional[str] = None):
    """Ranked ingredient suggestions for a meal block's line, `used` being a
    comma-separated list of the ingredient ids already written on that
    block (they seed the co-occurrence signal and drop out of the
    results). `week` puts that week's shopping lists at the top -- the
    pool a meal is meant to be built from."""
    with_ids = [i for i in used.split(",") if i.strip()]
    return {"suggestions": suggest.ingredients_for(
        q=q, meal=meal, meal_name=meal_name, with_ids=with_ids,
        limit=max(1, min(limit, 25)), week=week)}


@app.get("/api/board/{week}/next-slot")
def next_slot(week: str, date: str, meal: str):
    """The key a second (or third) meal at one slot should be saved under
    -- the frontend shouldn't be inventing key formats."""
    if meal not in board.MEALS:
        raise HTTPException(400, "meal must be breakfast, lunch, or dinner")
    index = board.next_slot_index(week, date, meal)
    return {"slot_key": board.slot_key(date, meal, index), "index": index}


@app.put("/api/board/{week}/slots/{slot_key}")
def put_slot(week: str, slot_key: str, body: SlotBody):
    if recipes.get(body.recipe_id) is None:
        raise HTTPException(404, "no such recipe")
    overrides = [i.model_dump() for i in body.ingredient_overrides] if body.ingredient_overrides else None
    return board.set_slot(week, slot_key, body.recipe_id, body.servings_used, overrides)


# ── bangers (the best meals, per meal type) ──────────────────────────────

class BangerBody(BaseModel):
    meal: str
    recipe_id: str


def _banger_view(b: dict) -> Optional[dict]:
    recipe = recipes.get(b["recipe_id"])
    if recipe is None:
        return None
    ing_by_id = ingredients.by_id()
    summary = _recipe_summary(recipe, ing_by_id)
    return {**b, "name": recipe["name"], "servings": recipe["servings"], "notes": recipe.get("notes", ""),
            "lines": [{"name": (ing_by_id.get(i["ingredient_id"]) or {}).get("name", "?"),
                       "qty": i["qty"], "unit": i["unit"], "note": i.get("note", "")}
                      for i in recipe["ingredients"]],
            "nutrition": summary["nutrition_per_serving"],
            "unknown": len(summary["unknown_ingredients"])}


@app.get("/api/bangers")
def get_bangers():
    return {"bangers": [v for v in map(_banger_view, bangers.list_bangers()) if v]}


@app.post("/api/bangers")
def create_banger(body: BangerBody):
    if body.meal not in board.MEALS:
        raise HTTPException(400, "meal must be breakfast, lunch, or dinner")
    if recipes.get(body.recipe_id) is None:
        raise HTTPException(404, "no such recipe")
    return {"banger": bangers.add(body.meal, body.recipe_id)}


@app.delete("/api/bangers/{banger_id}")
def remove_banger(banger_id: str):
    if not bangers.delete(banger_id):
        raise HTTPException(404, "no such banger")
    return get_bangers()


# ── routines (a meal that repeats) ───────────────────────────────────────

class RoutineBody(BaseModel):
    meal: str
    recipe_id: str
    weekday: Optional[str] = None        # None = every day
    servings_used: float = 1
    ingredient_overrides: Optional[list[RecipeIngredient]] = None
    start_date: Optional[str] = None


@app.get("/api/routines")
def get_routines():
    out = []
    for routine in routines.list_routines():
        recipe = recipes.get(routine["recipe_id"])
        out.append({**routine, "name": recipe["name"] if recipe else "(deleted meal)"})
    return {"routines": out}


@app.post("/api/routines")
def create_routine(body: RoutineBody):
    if body.meal not in board.MEALS:
        raise HTTPException(400, "meal must be breakfast, lunch, or dinner")
    if body.weekday is not None and body.weekday not in routines.WEEKDAYS:
        raise HTTPException(400, "weekday must be a lowercase weekday name, or null for every day")
    if recipes.get(body.recipe_id) is None:
        raise HTTPException(404, "no such recipe")
    overrides = [i.model_dump() for i in body.ingredient_overrides] if body.ingredient_overrides else None
    routine = routines.add(body.meal, body.recipe_id, body.weekday,
                           body.start_date, body.servings_used, overrides)
    return {"routine": routine}


@app.delete("/api/routines/{routine_id}")
def remove_routine(routine_id: str):
    if not routines.delete(routine_id):
        raise HTTPException(404, "no such routine")
    return {"routines": routines.list_routines()}


@app.delete("/api/board/{week}/slots/{slot_key}")
def delete_slot(week: str, slot_key: str):
    try:
        return board.clear_slot(week, slot_key)
    except KeyError:
        raise HTTPException(404, "no such slot")


@app.get("/api/board/{week}/diversity")
def get_diversity(week: str):
    return board.week_diversity(week)


@app.post("/api/board/{week}/leftover-groups/link")
def link_leftover_group(week: str, body: LinkBody):
    try:
        return board.link_slots(week, body.slot_a, body.slot_b)
    except KeyError as exc:
        raise HTTPException(400, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


# ── nutrition dashboard ──────────────────────────────────────────────────

def _member_view(totals: dict, member: dict) -> dict:
    return {"member": member, "totals": totals, "status": nutrition.status_report(totals, member["targets"])}


@app.get("/api/nutrition/day")
def nutrition_day(date: str, member_id: Optional[str] = None):
    totals = nutrition.day_totals(date)
    if member_id:
        member = household.get_member(member_id)
        if member is None:
            raise HTTPException(404, "no such household member")
        return {"date": date, **_member_view(totals, member)}
    members = [_member_view(totals, m) for m in household.list_members() if m.get("active", True)]
    return {"date": date, "totals": totals, "members": members}


@app.get("/api/nutrition/week")
def nutrition_week(week: Optional[str] = None, member_id: Optional[str] = None):
    weekly = nutrition.week_totals(week or board.current_week_start())
    if member_id:
        member = household.get_member(member_id)
        if member is None:
            raise HTTPException(404, "no such household member")
        return {**weekly, **_member_view(weekly["total"], member)}
    members = [_member_view(weekly["total"], m) for m in household.list_members() if m.get("active", True)]
    return {**weekly, "members": members}


class PreviewBody(BaseModel):
    rows: list[RecipeIngredient] = []


@app.post("/api/nutrition/preview")
def preview_nutrition(body: PreviewBody):
    """Live nutrition for a draft ingredient list that hasn't been saved as
    a recipe yet -- the meal editor calls this on every row edit."""
    return nutrition.preview_totals([r.model_dump() for r in body.rows], ingredients.by_id())


class PreviewBatchBody(BaseModel):
    blocks: dict[str, list[RecipeIngredient]] = {}


@app.post("/api/nutrition/preview-batch")
def preview_nutrition_batch(body: PreviewBatchBody):
    """One request for every meal block on screen -- the week view draws 21
    of them and would otherwise fire 21 separate previews on load."""
    blocks = {key: [r.model_dump() for r in rows] for key, rows in body.blocks.items()}
    return {"blocks": nutrition.preview_batch(blocks, ingredients.by_id())}


# ── groceries ────────────────────────────────────────────────────────────

class GroceryItemBody(BaseModel):
    bought_qty_g: Optional[float] = None
    section: Optional[str] = None
    checked: Optional[bool] = None


class SectionBody(BaseModel):
    section: Optional[str] = None


@app.get("/api/groceries/{week}")
def get_groceries(week: str):
    items = groceries.get_week_groceries(week)
    return {"items": items, "totals": groceries.list_totals(items),
            "store": groceries.active_shop("grocery"), "market": groceries.active_shop("market")}


class PriceBody(BaseModel):
    price: float
    package_g: Optional[float] = None
    label: str = ""


@app.post("/api/groceries/prices/{ingredient_id}")
def set_price(ingredient_id: str, body: PriceBody):
    """What this costs at the store you shop at -- typed once, remembered
    from then on."""
    ing = ingredients.get(ingredient_id)
    if ing is None:
        raise HTTPException(404, "no such ingredient")
    shop = groceries.active_shop(aisles.list_for(ing))
    entry = prices.remember(ingredient_id, shop, body.price, body.package_g, body.label)
    return {"price": entry}


@app.delete("/api/groceries/prices/{ingredient_id}")
def clear_price(ingredient_id: str):
    ing = ingredients.get(ingredient_id)
    if ing is None:
        raise HTTPException(404, "no such ingredient")
    prices.forget(ingredient_id, groceries.active_shop(aisles.list_for(ing)))
    return {"ok": True}


class PriceLookupBody(BaseModel):
    ids: list[str] = []


@app.post("/api/groceries/{week}/prices/lookup")
def lookup_prices(week: str, body: PriceLookupBody):
    """Live prices for the list's unpriced rows, asked for by the list itself (a few at a time)."""
    if not prices.kroger_configured():
        return {"found": 0}
    return {"found": groceries.price_missing(week, body.ids)}


@app.post("/api/groceries/{week}/prices/refresh")
def refresh_prices(week: str):
    """Go and fetch live prices for the whole list. Only ever on request:
    a redraw must not turn into forty API calls (see groceries.py)."""
    if not prices.kroger_configured():
        raise HTTPException(400, "no store price key set — add Kroger credentials in Settings")
    items = groceries.get_week_groceries(week, allow_network=True)
    return {"items": items, "totals": groceries.list_totals(items)}


@app.put("/api/groceries/{week}/items/{ingredient_id}")
def put_grocery_item(week: str, ingredient_id: str, body: GroceryItemBody):
    item = groceries.update_item(week, ingredient_id, body.model_dump(exclude_unset=True))
    return {"item": item}


class PackageBody(BaseModel):
    package: Optional[dict] = None     # {package_g, price, label}; None = back to the usual size


@app.put("/api/groceries/{week}/items/{ingredient_id}/package")
def put_grocery_package(week: str, ingredient_id: str, body: PackageBody):
    """The bigger pack from the row's bulk hint (or back to the normal one)."""
    groceries.set_package(week, ingredient_id, body.package)
    items = groceries.get_week_groceries(week)
    return {"items": items, "totals": groceries.list_totals(items)}


@app.get("/api/groceries/{week}/sizes/{ingredient_id}")
def get_sizes(week: str, ingredient_id: str):
    """The sizes the picked store carries of it -- offered while an amount is typed."""
    return {"sizes": [{"text": stock.us_amount(o["package_g"]), "price": o["price"], "label": o["label"],
                       "product": stock.product_name(o["label"])}
                      for o in stock.Ledger().sizes(week, ingredient_id)]}


@app.get("/api/stock/{week}")
def get_stock(week: str):
    """What's on hand at the start of the week: fridge/pantry and freezer, and when each runs out."""
    return {"items": stock.Ledger().on_hand(week)}


class StockBody(BaseModel):
    grams: Optional[float] = None
    text: Optional[str] = None         # "1 lb" -- typed on the On hand drawer
    frozen: Optional[bool] = None


@app.put("/api/stock/{week}/{ingredient_id}")
def put_stock(week: str, ingredient_id: str, body: StockBody):
    """A correction: there's actually this much (0 = used up)."""
    grams = body.grams
    if grams is None:
        grams = prices._parse_grams(body.text or "") or 0.0
    stock.correct(ingredient_id, grams, week, body.frozen)
    return {"items": stock.Ledger().on_hand(week)}


@app.post("/api/groceries/{week}/items/{ingredient_id}/section")
def set_grocery_section(week: str, ingredient_id: str, body: SectionBody):
    item = groceries.set_section(week, ingredient_id, body.section)
    return {"item": item}


@app.get("/api/groceries/{week}/allocation")
def get_allocation(week: str):
    return {"items": groceries.get_allocation(week)}


@app.get("/api/groceries/{week}/export")
def export_groceries(week: str, section: str, format: str = "text"):
    return PlainTextResponse(groceries.export_text(week, section))


# ── extra items (hand-added, not derived from any recipe) ─────────────────

class ExtraItemBody(BaseModel):
    ingredient_id: str
    qty_g: Optional[float] = None   # a bare name is a whole entry
    qty: Optional[str] = None       # the amount as typed ("2 lb"), never converted
    shop_list: Optional[str] = None # the box it was typed into: it goes on THAT list


@app.post("/api/groceries/{week}/extra")
def add_extra_grocery_item(week: str, body: ExtraItemBody):
    if ingredients.get(body.ingredient_id) is None:
        raise HTTPException(404, "no such ingredient")
    return {"items": groceries.add_extra_item(week, body.ingredient_id, body.qty_g, body.qty, body.shop_list)}


@app.delete("/api/groceries/{week}/extra/{ingredient_id}")
def remove_extra_grocery_item(week: str, ingredient_id: str):
    return {"items": groceries.remove_extra_item(week, ingredient_id)}


class SwapBody(BaseModel):
    to: str


@app.post("/api/groceries/{week}/items/{ingredient_id}/swap")
def swap_grocery_item(week: str, ingredient_id: str, body: SwapBody):
    """A hand-added row renamed: it becomes that ingredient (amount, tick, list kept)."""
    if ingredients.get(body.to) is None:
        raise HTTPException(404, "no such ingredient")
    return {"items": groceries.swap_item(week, ingredient_id, body.to)}


class AmountBody(BaseModel):
    qty: str = ""


@app.put("/api/groceries/{week}/items/{ingredient_id}/amount")
def put_grocery_amount(week: str, ingredient_id: str, body: AmountBody):
    """The amount typed on a list row, as typed."""
    return {"items": groceries.set_amount(week, ingredient_id, body.qty)}


@app.delete("/api/groceries/{week}/items/{ingredient_id}")
def remove_grocery_item(week: str, ingredient_id: str):
    """The swipe: off this week's list, whether a meal or a hand-add put it there."""
    return {"items": groceries.remove_item(week, ingredient_id)}


# ── the usuals (learned from what's hand-added week after week) ────────────

@app.get("/api/groceries/{week}/suggestions")
def get_grocery_suggestions(week: str):
    return {"items": groceries.suggestions(week)}


@app.post("/api/groceries/{week}/suggestions/{key:path}/accept")
def accept_grocery_suggestion(week: str, key: str):
    try:
        groceries.accept_suggestion(week, key)
    except KeyError:
        raise HTTPException(404, "no such suggestion")
    return {"ok": True}


@app.post("/api/groceries/{week}/suggestions/{key:path}/dismiss")
def dismiss_grocery_suggestion(week: str, key: str):
    groceries.dismiss_suggestion(week, key)
    return {"ok": True}


# ── free list (unstructured, e.g. farmer's market) ─────────────────────────

class FreeItemBody(BaseModel):
    text: str
    qty: str = ""


class FreeItemUpdateBody(BaseModel):
    text: Optional[str] = None
    checked: Optional[bool] = None
    qty: Optional[str] = None       # the amount, as typed ("6", "2 baskets")


@app.get("/api/groceries/{week}/free-list")
def get_free_list(week: str):
    return {"items": groceries.list_free_items(week)}


@app.post("/api/groceries/{week}/free-list")
def add_free_list_item(week: str, body: FreeItemBody):
    if not body.text.strip():
        raise HTTPException(400, "a free list line needs some text")
    return {"items": groceries.add_free_item(week, body.text, body.qty)}


@app.put("/api/groceries/{week}/free-list/{item_id}")
def put_free_list_item(week: str, item_id: str, body: FreeItemUpdateBody):
    try:
        return {"items": groceries.update_free_item(week, item_id, body.model_dump(exclude_unset=True))}
    except KeyError:
        raise HTTPException(404, "no such free list item")


@app.delete("/api/groceries/{week}/free-list/{item_id}")
def delete_free_list_item(week: str, item_id: str):
    try:
        return {"items": groceries.delete_free_item(week, item_id)}
    except KeyError:
        raise HTTPException(404, "no such free list item")


@app.get("/api/groceries/{week}/free-list/export")
def export_free_list(week: str):
    return PlainTextResponse(groceries.free_list_export_text(week))


# ── learning loop ────────────────────────────────────────────────────────

class IngredientLogBody(BaseModel):
    week: str
    outcome: str  # ran_out | leftover | used_exactly
    actual_qty_g: Optional[float] = None


class MealLogBody(BaseModel):
    week: str
    slot: str
    outcome: str  # eaten | skipped


@app.post("/api/learning/ingredients/{ingredient_id}/log")
def log_ingredient(ingredient_id: str, body: IngredientLogBody):
    items = {i["ingredient_id"]: i for i in groceries.get_week_groceries(body.week)}
    item = items.get(ingredient_id)
    planned = item["planned_qty_g"] if item else 0.0
    bought = item["bought_qty_g"] if item else None
    entry = learning.log_ingredient(ingredient_id, body.week, planned, body.outcome, body.actual_qty_g, bought)
    return {"entry": entry}


@app.post("/api/learning/meals/{recipe_id}/log")
def log_meal(recipe_id: str, body: MealLogBody):
    entry = learning.log_meal(recipe_id, body.week, body.slot, body.outcome)
    return {"entry": entry}


@app.get("/api/learning/nudges")
def get_nudges():
    return {"nudges": learning.nudges()}


@app.get("/api/learning/ingredients/{ingredient_id}")
def get_ingredient_history(ingredient_id: str):
    entry = learning.ingredient_entry(ingredient_id)
    return entry or {"events": [], "rolling_avg_actual_g": None, "rolling_avg_ratio": None}


@app.get("/api/learning/meals/{recipe_id}")
def get_meal_history(recipe_id: str):
    entry = learning.meal_entry(recipe_id) or {"events": []}
    return {**entry, "frequency": stats.meal_frequency(recipe_id), "trend": stats.ingredient_trend(recipe_id)}


@app.delete("/api/learning")
def clear_learning():
    learning.clear()
    return {"ok": True}


@app.middleware("http")
async def always_revalidate(request, call_next):
    """QtWebEngine keeps a disk cache, and with no Cache-Control header
    Chromium falls back to heuristic freshness -- which meant a reinstalled
    app could keep rendering the previous release's CSS. Everything here is
    served off localhost, so revalidating every asset costs nothing and the
    ETag keeps it a 304."""
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


app.mount("/", StaticFiles(directory=str(WEB_DIR)), name="web")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8781)
