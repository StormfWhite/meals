#!/usr/bin/env bash
# Rebuild the phone/web Meal Planner from the laptop app's source (~/Documents/mealplanner):
# the same Python package + FastAPI routes run in the browser (Pyodide, see bridge.js) and the
# same front end is served with a phone stylesheet on top. Run after any change to the laptop app,
# then commit + push to publish (stormfwhite.github.io/meals).
set -e
SRC="$HOME/Documents/mealplanner"
OUT="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$OUT/py" && mkdir -p "$OUT/py/app/web"
rsync -a --exclude __pycache__ "$SRC/mealplanner" "$OUT/py/"
cp "$SRC/app/server.py" "$OUT/py/app/" && touch "$OUT/py/app/__init__.py"
(cd "$OUT/py" && find . -name "*.py" | sed 's|^\./||' | sort) > "$OUT/py/files.txt"
for f in "$SRC"/app/web/*.js "$SRC"/app/web/style.css; do cp "$f" "$OUT/"; done
# index.html: relative paths (the site lives under /meals/), then the phone bits
sed -e 's|href="/|href="|g; s|src="/|src="|g' \
    -e 's|<link rel="stylesheet" href="style.css">|<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="mobile.css">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="apple-mobile-web-app-capable" content="yes">\n<meta name="mobile-web-app-capable" content="yes">\n<meta name="apple-mobile-web-app-title" content="Meals">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="apple-touch-icon" href="icon-180.png">\n<link rel="icon" href="icon-192.png">|' \
    -e 's|<script src="app.js"></script>|<script src="https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js"></script>\n<script src="bridge.js"></script>\n<script src="app.js"></script>|' \
    "$SRC/app/web/index.html" > "$OUT/index.html"
# py.zip: everything Python needs in ONE download, already compiled -- our package + server and the
# three pure-Python wheels unpacked beside them, each with its .pyc (Pyodide 0.27 = CPython 3.12, same
# bytecode as this machine's 3.12; unchecked-hash so the browser never re-reads the source to validate).
# It replaces ~25 separate fetches + micropip + compiling fastapi/starlette on every open.
python3 - "$OUT" <<'PY'
import compileall, py_compile, shutil, sys, tempfile, zipfile
from pathlib import Path
out = Path(sys.argv[1]); tmp = Path(tempfile.mkdtemp())
shutil.copytree(out / "py", tmp, dirs_exist_ok=True)
for whl in (out / "wheels").glob("*.whl"):
    with zipfile.ZipFile(whl) as z:
        z.extractall(tmp)
for junk in tmp.glob("*.dist-info"):
    shutil.rmtree(junk)
assert sys.version_info[:2] == (3, 12), "pyc must match Pyodide's CPython 3.12"
compileall.compile_dir(tmp, quiet=1, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
with zipfile.ZipFile(out / "py.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(tmp.rglob("*")):
        if f.is_file() and f.name != "files.txt":
            z.write(f, f.relative_to(tmp))
shutil.rmtree(tmp)
print("py.zip", (out / "py.zip").stat().st_size // 1024, "KB")
PY
touch "$OUT/.nojekyll"   # GitHub Pages would drop __init__.py
echo "built from $SRC ($(wc -l < "$OUT/py/files.txt") python files)"
