/*
 * Meal Planner on a phone: the laptop app's own Python package and FastAPI routes, running in the
 * browser (Pyodide), behind the laptop app's own front end. Every `fetch("/api/…")` the front end
 * makes is answered here by calling the ASGI app directly — no server anywhere.
 *
 * Data: the planner's files live in Dropbox /mealplanner (the laptop app reads the same folder,
 * see mealplanner/paths.py). They're mirrored into Python's filesystem at /data and cached in
 * IndexedDB so the app opens instantly and works offline. After a change, every file Python
 * rewrote is uploaded with Dropbox's revision check; if someone else saved first, their files are
 * pulled and the requests made since the last upload are REPLAYED on top — the same API calls,
 * so the planner's own rules (leftover groups, routines, lists) decide the merge.
 * Longpoll brings the other side's changes in live.
 */
"use strict";
(() => {
  const APP_KEY = "qsmbpc4l1v4uini";
  const FOLDER = "/mealplanner";
  const LS = "meals.v1";
  const DATA = "/data";
  const PY_FILES = "py/";
  const narrow = () => innerWidth < 760;

  const S = (() => {
    try { return Object.assign({ refresh: "", access: "", exp: 0, cursor: "", revs: {} }, JSON.parse(localStorage.getItem(LS) || "{}")); }
    catch { return { refresh: "", access: "", exp: 0, cursor: "", revs: {} }; }
  })();
  if (!S.refresh) {   // same site as Shared Notes: reuse its Dropbox connection when this browser has one
    try { const n = JSON.parse(localStorage.getItem("sharednotes.v1") || "{}"); if (n.refresh) S.refresh = n.refresh; } catch {}
  }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(S)); } catch {} };

  // ---- splash ----------------------------------------------------------------------------------
  const splash = document.createElement("div");
  splash.id = "boot";
  splash.innerHTML = `<img src="icon-180.png" alt=""><div class="boot-t">Meal Planner</div><div class="boot-s" id="boot-s">Starting…</div>
    <div id="boot-connect" hidden>
      <p>Connect once to the Dropbox the plan lives in.</p>
      <button class="boot-btn" id="boot-go">Connect Dropbox</button>
      <div id="boot-code" hidden><p>Tap <b>Allow</b>, copy the code Dropbox shows, paste it here.</p>
        <input id="boot-in" placeholder="Paste code" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="boot-btn" id="boot-done">Done</button></div>
      <p class="boot-err" id="boot-err"></p>
    </div>`;
  const say = (t) => { const e = document.getElementById("boot-s"); if (e) e.textContent = t; };
  document.addEventListener("DOMContentLoaded", () => {
    document.body.appendChild(splash);
    if (narrow() && window.App && App.plan) {   // a phone: one day at a time, the list behind the cart button
      App.plan._forceMode = "day";
      App.plan._listOpen = false;
      App.plan._listTouched = true;
    }
  });

  // ---- Dropbox ---------------------------------------------------------------------------------
  const asciiJson = (o) => JSON.stringify(o).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function token() {
    if (S.access && Date.now() < S.exp) return S.access;
    const r = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: S.refresh, client_id: APP_KEY }),
    });
    if (!r.ok) { if (r.status === 400 || r.status === 401) { S.refresh = ""; save(); } throw new Error("Dropbox sign-in " + r.status); }
    const o = await r.json();
    S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000; save();
    return S.access;
  }
  async function rpc(path, arg) {
    for (let a = 0; ; a++) {
      const r = await fetch("https://api.dropboxapi.com/2/" + path, { method: "POST",
        headers: { Authorization: "Bearer " + (await token()), "Content-Type": "application/json" }, body: JSON.stringify(arg) });
      if (r.status === 401 && a === 0) { S.exp = 0; continue; }
      if (r.status === 429 && a < 3) { await sleep(3000); continue; }
      const t = await r.text();
      if (!r.ok) { const e = new Error(path + " " + r.status); e.status = r.status; e.body = t; throw e; }
      return JSON.parse(t);
    }
  }
  async function content(path, arg, body) {
    for (let a = 0; ; a++) {
      const h = { Authorization: "Bearer " + (await token()), "Dropbox-API-Arg": asciiJson(arg) };
      if (body !== undefined) h["Content-Type"] = "application/octet-stream";
      const r = await fetch("https://content.dropboxapi.com/2/" + path, { method: "POST", headers: h, body });
      if (r.status === 401 && a === 0) { S.exp = 0; continue; }
      if (r.status === 429 && a < 3) { await sleep(3000); continue; }
      if (!r.ok) { const t = await r.text(); const e = new Error(path + " " + r.status); e.status = r.status; e.body = t; throw e; }
      return r;
    }
  }

  // ---- connect (PKCE, code pasted back) ----------------------------------------------------------
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function connect() {
    return new Promise((resolve) => {
      document.getElementById("boot-connect").hidden = false;
      say("");
      document.getElementById("boot-go").onclick = async () => {
        const v = b64url(crypto.getRandomValues(new Uint8Array(48)));
        localStorage.setItem(LS + ".pkce", v);
        const ch = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
        window.open("https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({ client_id: APP_KEY, response_type: "code",
          token_access_type: "offline", code_challenge_method: "S256", code_challenge: ch }), "_blank");
        document.getElementById("boot-code").hidden = false;
      };
      document.getElementById("boot-done").onclick = async () => {
        const code = document.getElementById("boot-in").value.trim();
        if (!code) return;
        try {
          const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: APP_KEY, code_verifier: localStorage.getItem(LS + ".pkce") || "" }) });
          const o = await r.json();
          if (!r.ok) throw new Error(o.error_description || o.error || r.status);
          S.refresh = o.refresh_token; S.access = o.access_token; S.exp = Date.now() + (o.expires_in - 120) * 1000; save();
          document.getElementById("boot-connect").hidden = true;
          resolve();
        } catch (e) { document.getElementById("boot-err").textContent = "That didn't work (" + e.message + "). Tap Connect Dropbox for a fresh code."; }
      };
    });
  }

  // ---- local cache of the files (IndexedDB) --------------------------------------------------------
  const idb = new Promise((res, rej) => {
    const q = indexedDB.open("meals", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("files");
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  async function idbAll() {
    const db = await idb;
    return new Promise((res) => {
      const out = {}, tx = db.transaction("files"), st = tx.objectStore("files");
      st.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); };
    });
  }
  async function idbPut(name, bytes) {
    const db = await idb;
    return new Promise((res) => { const tx = db.transaction("files", "readwrite"); tx.objectStore("files").put(bytes, name); tx.oncomplete = res; });
  }

  // ---- Python ------------------------------------------------------------------------------------
  let py = null, call = null;
  const synced = {};   // name → bytes as last agreed with Dropbox
  const eq = (a, b) => { if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const isData = (n) => /^[\w.-]+\.(json|sqlite)$/.test(n);

  async function bootPython() {
    say("Loading planner…");
    py = await loadPyodide();
    await py.loadPackage(["micropip", "pydantic", "sqlite3", "requests", "anyio", "sniffio", "typing-extensions", "ssl"]);
    say("Loading planner…  (first time takes a moment)");
    await py.runPythonAsync(`
import micropip
await micropip.install([${["fastapi-0.115.6-py3-none-any.whl", "starlette-0.41.3-py3-none-any.whl", "pyodide_http-0.2.1-py3-none-any.whl"]
      .map((w) => JSON.stringify(new URL("wheels/" + w, location.href).href)).join(",")}], deps=False)
`);
    const files = (await (await fetch(PY_FILES + "files.txt", { cache: "no-cache" })).text()).trim().split("\n");
    await Promise.all(files.map(async (f) => {
      const src = await (await fetch(PY_FILES + f, { cache: "no-cache" })).text();
      const p = "/src/" + f;
      py.FS.mkdirTree(p.slice(0, p.lastIndexOf("/")));
      py.FS.writeFile(p, src);
    }));
    py.FS.mkdirTree("/src/app/web");
    py.FS.mkdirTree(DATA);
  }

  async function startApp() {
    await py.runPythonAsync(`
import os, sys
sys.path.insert(0, "/src")
os.environ["MEALPLANNER_DATA"] = "${DATA}"
os.environ["HOME"] = "/home/pyodide"
import pyodide_http
pyodide_http.patch_all()          # requests/urllib → the browser's own HTTP (USDA, OpenStreetMap)
import starlette.concurrency, fastapi.routing, fastapi.dependencies.utils
async def _direct(func, *a, **k):  # no threads in a browser: run sync route handlers inline
    return func(*a, **k)
for _m in (starlette.concurrency, fastapi.routing, fastapi.dependencies.utils):
    if hasattr(_m, "run_in_threadpool"): _m.run_in_threadpool = _direct
from app.server import app as _app
async def _call(method, path, body):
    msgs, sent = [], False
    p, _, q = path.partition("?")
    scope = {"type": "http", "method": method, "path": p, "raw_path": p.encode(), "query_string": q.encode(),
             "headers": [(b"content-type", b"application/json")], "http_version": "1.1", "scheme": "http",
             "server": ("meals", 80), "client": ("phone", 1), "root_path": ""}
    async def receive():
        nonlocal sent
        if sent: return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": (body or "").encode(), "more_body": False}
    async def send(m): msgs.append(m)
    await _app(scope, receive, send)
    status = next(m["status"] for m in msgs if m["type"] == "http.response.start")
    return status, b"".join(m.get("body", b"") for m in msgs if m["type"] == "http.response.body").decode()
`);
    call = py.globals.get("_call");
  }

  function writeFile(name, bytes) { py.FS.writeFile(DATA + "/" + name, bytes); }
  function readFile(name) { try { return py.FS.readFile(DATA + "/" + name); } catch { return null; } }
  const localNames = () => py.FS.readdir(DATA).filter(isData);

  // ---- sync ----------------------------------------------------------------------------------------
  let pending = [];      // mutating requests made since the last successful upload (replayed on conflict)
  let busy = Promise.resolve();
  const serial = (fn) => (busy = busy.then(fn, fn));

  async function firstLoad() {
    const cached = await idbAll();
    if (S.cursor && Object.keys(cached).length) {   // instant start from the local copy, catch up after
      for (const [n, b] of Object.entries(cached)) { if (isData(n)) { writeFile(n, b); synced[n] = b; } }
      return;
    }
    say("Getting your plan…");
    let page = await rpc("files/list_folder", { path: FOLDER, recursive: false });
    const entries = [];
    for (;;) { entries.push(...page.entries); if (!page.has_more) break; page = await rpc("files/list_folder/continue", { cursor: page.cursor }); }
    for (const e of entries) {
      if (e[".tag"] !== "file" || !isData(e.name)) continue;
      const r = await content("files/download", { path: e.path_lower });
      const b = new Uint8Array(await r.arrayBuffer());
      writeFile(e.name, b); synced[e.name] = b; S.revs[e.name] = e.rev; await idbPut(e.name, b);
    }
    S.cursor = page.cursor; save();
  }

  /** Bring the other side's changes in. Returns true if anything changed. */
  async function pull() {
    if (!S.cursor) return false;
    let page;
    try { page = await rpc("files/list_folder/continue", { cursor: S.cursor }); }
    catch (e) { if (e.status === 409) { S.cursor = ""; save(); await firstLoad(); return true; } throw e; }
    let changed = false;
    for (;;) {
      for (const e of page.entries) {
        if (e[".tag"] !== "file" || !isData(e.name) || S.revs[e.name] === e.rev) continue;
        const r = await content("files/download", { path: e.path_lower });
        const b = new Uint8Array(await r.arrayBuffer());
        S.revs[e.name] = e.rev; synced[e.name] = b; await idbPut(e.name, b);
        writeFile(e.name, b);
        changed = true;
      }
      S.cursor = page.cursor;
      if (!page.has_more) break;
      page = await rpc("files/list_folder/continue", { cursor: page.cursor });
    }
    save();
    if (changed && pending.length) {   // their files are in; put our recent edits back on top
      const again = pending; pending = [];
      for (const q of again) { await call(q.method, q.path, q.body); pending.push(q); }
    }
    return changed;
  }

  /** Upload every file Python changed. On a revision conflict: pull theirs, replay, retry. */
  async function push() {
    for (let attempt = 0; attempt < 4; attempt++) {
      let conflict = false;
      for (const n of localNames()) {
        const b = readFile(n);
        if (!b || eq(b, synced[n])) continue;
        const mode = S.revs[n] ? { ".tag": "update", update: S.revs[n] } : "add";
        try {
          const r = await content("files/upload", { path: `${FOLDER}/${n}`, mode, autorename: false, mute: true }, b);
          const meta = await r.json();
          S.revs[n] = meta.rev; synced[n] = b.slice(); await idbPut(n, synced[n]); save();
        } catch (e) {
          if (e.status !== 409) throw e;
          conflict = true;
          break;
        }
      }
      if (!conflict) { pending = []; return; }
      await pull();
    }
  }

  let pushT = 0, online = true;
  function schedulePush() {
    clearTimeout(pushT);
    pushT = setTimeout(() => serial(() => push().then(() => setOnline(true)).catch((e) => { console.warn(e); setOnline(false); })), 400);
  }
  function setOnline(ok) {
    online = ok;
    document.body.classList.toggle("offline", !ok);
  }

  // re-draw after a remote change — but never under someone's fingers
  let redrawWanted = false;
  function redraw() {
    const a = document.activeElement;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT")) { redrawWanted = true; return; }
    redrawWanted = false;
    if (window.App && App.render) App.render();
  }
  document.addEventListener("focusout", () => setTimeout(() => { if (redrawWanted) redraw(); }, 300));

  let polling = false;
  async function longpoll() {
    if (polling) return;
    polling = true;
    try {
      while (document.visibilityState === "visible" && S.cursor) {
        try {
          const r = await fetch("https://notify.dropboxapi.com/2/files/list_folder/longpoll", { method: "POST",
            headers: { "Content-Type": "text/plain; charset=dropbox-cors-hack" }, body: JSON.stringify({ cursor: S.cursor, timeout: 60 }) });
          const o = await r.json();
          if (o.changes) { const ch = await serial(() => pull()); if (ch) { redraw(); schedulePush(); } setOnline(true); }
          if (o.backoff) await sleep(o.backoff * 1000);
        } catch { setOnline(false); await sleep(8000); }
      }
    } finally { polling = false; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ready) serial(() => pull()).then((ch) => { if (ch) redraw(); longpoll(); }).catch(() => {});
  });
  addEventListener("online", () => { if (ready) { schedulePush(); longpoll(); } });

  // ---- boot + the fetch bridge -------------------------------------------------------------------
  let ready = false;
  const booted = (async () => {
    const pyLoad = bootPython();
    if (!S.refresh) await connect();
    await pyLoad;
    await firstLoad();
    await startApp();
    ready = true;
    splash.classList.add("gone");
    setTimeout(() => splash.remove(), 400);
    serial(() => pull()).then((ch) => { if (ch) redraw(); longpoll(); }).catch(() => setOnline(false));
  })().catch((e) => { console.error(e); say("Couldn't start: " + e.message); });

  // Recipes from the Notes app: its notes sit beside the meal data in this same Dropbox app folder
  // (/notes). The picker asks for them, so they come down then -- one zip (~1.5 MB), at most every
  // 2 minutes -- into /notes.zip, where recipe_import.py reads them. Offline: the last zip, if any.
  let notesAt = 0;
  async function notesZip() {
    if (Date.now() - notesAt < 120000) return;
    try {
      const r = await content("files/download_zip", { path: "/notes" });
      py.FS.writeFile("/notes.zip", new Uint8Array(await r.arrayBuffer()));
      notesAt = Date.now();
    } catch (e) { console.warn("notes zip", e); }
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    const at = url.pathname.indexOf("/api/");
    if (url.origin !== location.origin || at < 0) return realFetch(input, opts);
    await booted;
    const method = (opts.method || "GET").toUpperCase();
    const path = url.pathname.slice(at) + url.search;
    if (path.startsWith("/api/notes")) await notesZip();
    const body = typeof opts.body === "string" ? opts.body : "";
    const res = await serial(async () => {
      const r = (await call(method, path, body)).toJs();
      if (method !== "GET") pending.push({ method, path, body });
      return r;
    });
    schedulePush();   // GETs can write too (the USDA cache, store lookups); push() skips unchanged files
    return new Response(res[0] === 204 ? null : res[1], { status: res[0], headers: { "Content-Type": "application/json" } });
  };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.__meals_py = () => py;
  window.__meals = { S, pull, push, get pending() { return pending; }, get ready() { return ready; }, booted };
})();
