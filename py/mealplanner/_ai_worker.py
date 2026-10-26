"""One picture + one question -> the model's answer, through StudyCode's model_manager.

Run as a subprocess under StudyCode's interpreter, never imported (pantry_scan.py starts it):
the meal planner's own venv has no AI libraries, and model_manager already owns the keys, the
measured model ranking (model_roles "vision") and the shared rate ledger -- in LocalAI.txt mode
the same call lands on jorm's GPU instead of Google. Same shape as pricehunt's _ai_worker.py.

stdin:  {"prompt": "...", "image_b64": "...", "mime": "image/jpeg"}
stdout: {"ok": true, "text": "..."}  or  {"ok": false, "error": "..."}

Stdout is reserved for that one line: model_manager narrates its race there, so fd 1 goes to
stderr before anything is imported and the answer leaves on a private copy of the real stdout.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from pathlib import Path

STUDYCODE = Path(os.environ.get("MEALPLANNER_STUDYCODE", str(Path.home() / "Documents" / "StudyCode")))

_ANSWER = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(obj: dict) -> None:
    _ANSWER.write(json.dumps(obj) + "\n")
    _ANSWER.flush()


def fail(msg: str) -> None:
    emit({"ok": False, "error": msg})
    sys.exit(0)


def read_lines(path: Path) -> list[str]:
    try:
        return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.startswith("#")]
    except OSError:
        return []


def main() -> None:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        image = base64.b64decode(req["image_b64"])
    except (ValueError, KeyError):
        fail("no picture")
    # this folder holds config.py / store.py etc., which would shadow what the SDK imports
    here = str(Path(__file__).resolve().parent)
    sys.path[:] = [p for p in sys.path if p not in (here, "", ".")]
    sys.path.insert(0, str(STUDYCODE))
    os.chdir(STUDYCODE)
    try:
        import model_manager          # also points the SDK at jorm in LocalAI.txt mode (_exe_paths)
        import model_roles
        from google import genai
        from google.genai import types
    except ImportError as exc:
        fail(f"model_manager unavailable ({exc})")

    models = [m for m in model_roles.models_for("vision", 8) if not m.startswith(("or:", "2s:"))]
    keys = read_lines(STUDYCODE / "Keys.txt")
    if not models:
        fail("no model measured able to see (" + model_roles.status("vision") + ")")
    if not keys:
        fail("no API keys in Keys.txt")
    prompt, mime = req.get("prompt") or "", req.get("mime") or "image/jpeg"

    def call_func(model: str, key: str, _prompt: str):
        try:
            client = genai.Client(api_key=key, http_options=types.HttpOptions(timeout=120_000))
            parts = [types.Part(text=prompt), types.Part.from_bytes(data=image, mime_type=mime)]
            r = client.models.generate_content(model=model, contents=[types.Content(role="user", parts=parts)])
            t = (r.text or "").strip()
            return (t, None) if t else (None, "empty response")
        except Exception as exc:                     # noqa: BLE001 - reported, not raised
            return None, str(exc)

    text, err = model_manager.call_with_fallback(
        models=models, keys=keys, prompt=prompt, call_func=call_func, race_n=3, max_retries=1,
        filter_by_perf=False, stagger_s=4.0, payload_bytes=len(image))
    if not text:
        fail(err or "no model answered")
    emit({"ok": True, "text": text})


if __name__ == "__main__":
    main()
