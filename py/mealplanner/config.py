"""Local config: the USDA FoodData Central API key and app-wide settings.

Stored at ~/.config/meal-planner/config.json -- never sent anywhere but
USDA's own API. Deliberately separate from ~/Documents/StudyCode/Keys.txt,
which holds unlabeled Gemini keys that model_manager.py round-robins
through as if they were interchangeable; appending a different provider's
key there would make it try to use an FDC key as a Gemini key. Follows
Print Finder's per-app config.py pattern exactly.
"""
from __future__ import annotations

from . import store
from .paths import CONFIG_FILE

_DEFAULTS = {
    "usda_fdc_api_key": "",
    "reup_day": "sunday",  # day the week's grocery list resets: monday..sunday
    # Kroger's public API (covers Harris Teeter and every other banner they
    # own). Free and self-serve at developer.kroger.com; without it the
    # price column falls back to what was paid last time -- see prices.py.
    "kroger_client_id": "",
    "kroger_client_secret": "",
}


def load() -> dict:
    data = store.load(CONFIG_FILE, {})
    return {**_DEFAULTS, **data}


def save(updates: dict) -> dict:
    current = load()
    for k, v in updates.items():
        if k in _DEFAULTS:
            current[k] = v.strip() if isinstance(v, str) else v
    store.save(CONFIG_FILE, current)
    return current


def get(key: str) -> str:
    return load().get(key, "") or ""


def fdc_key_set() -> bool:
    return bool(get("usda_fdc_api_key"))
