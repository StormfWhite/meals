"""Where Meal Planner's files live.

Split follows Price Hunt / Print Finder's convention: ~/.config for small
settings blobs, ~/.local/share for the app's durable data. Recipes, the
weekly board, the grocery lists and the learning history all live under
DATA_DIR -- they're real recorded work, not a cache, so losing them loses
a season of planning and logging. Only the USDA nutrient lookup cache is
disposable (rebuildable from the API), which is why it alone would belong
under ~/.cache if it grows large enough to need pruning; for now it lives
alongside the rest of DATA_DIR as fdc_cache.sqlite since SQLite already
handles its own growth.
"""
from __future__ import annotations

import os
from pathlib import Path

CONFIG_DIR = Path.home() / ".config" / "meal-planner"
CONFIG_FILE = CONFIG_DIR / "config.json"

# The plan is shared with the phones (stormfwhite.github.io/meals runs this same package in the
# browser): when this machine has the Dropbox app folder (Joanna's Dropbox -- the one account the
# laptop and both phones sign in to), the data AND the config live there, so Joanna's iPhone,
# Storm's Pixel and this laptop all read and write the same files. MEALPLANNER_DATA
# overrides (the browser sets it); without either it's the old local folder (tests, other machines).
SHARED_DIR = Path.home() / "Dropbox" / "Apps" / "SfwhiteNotes" / "mealplanner"
if os.environ.get("MEALPLANNER_DATA"):
    DATA_DIR = Path(os.environ["MEALPLANNER_DATA"])
elif SHARED_DIR.is_dir():
    DATA_DIR = SHARED_DIR
else:
    DATA_DIR = Path.home() / ".local" / "share" / "meal-planner"
if DATA_DIR != Path.home() / ".local" / "share" / "meal-planner":
    CONFIG_FILE = DATA_DIR / "config.json"

HOUSEHOLD_FILE = DATA_DIR / "household.json"
INGREDIENTS_FILE = DATA_DIR / "ingredients.json"
RECIPES_FILE = DATA_DIR / "recipes.json"
BOARD_FILE = DATA_DIR / "board.json"
GROCERIES_FILE = DATA_DIR / "groceries.json"
LEARNING_FILE = DATA_DIR / "learning.json"
ROUTINES_FILE = DATA_DIR / "routines.json"
PLACES_FILE = DATA_DIR / "places.json"
PRICES_FILE = DATA_DIR / "prices.json"
FDC_CACHE_FILE = DATA_DIR / "fdc_cache.sqlite"
# Rebuildable from OpenStreetMap, unlike everything above it -- deleting
# this only costs one Overpass call per place.
STORES_CACHE_FILE = DATA_DIR / "stores_cache.json"
PRICE_HISTORY_FILE = DATA_DIR / "price_history.json"   # every week's prices, kept for later use


def ensure_dirs() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
BANGERS_FILE = DATA_DIR / "bangers.json"
