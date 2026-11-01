/* Shared shell: view routing, toast, modal, fetch helper. Screen modules
 * (plan.js, nutrition.js, ...) attach a render() function to `App[name]`
 * and this file just calls whichever one matches the active view -- same
 * "no bundler, just script tags + a shared global" approach as the sibling
 * apps.
 *
 * There is no tab strip: the plan IS the app. Everything else is a
 * secondary screen behind an icon on the right of the top bar, and going
 * to one swaps in a back arrow rather than leaving a row of tabs on
 * screen. `#nav` is the top bar's one shared slot -- whichever view is
 * active fills it (the plan puts its date nav there instead of growing a
 * second toolbar under the header). */
window.App = window.App || {};

App.state = { view: "plan" };

App.api = async function (path, options = {}) {
  const opts = { headers: { "Content-Type": "application/json" }, ...options };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && App._rebaseStamp) setTimeout(App._rebaseStamp, 400);   // our own save, not the phone's
  if (res.status === 204) return null;
  return res.json();
};

/* Recipe photos (a cookbook page). Saved as JPEG files beside the plan; on a phone the bridge
 * answers /api/photos straight from Dropbox. A big camera picture is shrunk first -- a page of
 * a cookbook reads fine at 1800 px and goes up in a second instead of ten. */
App.shrinkPhoto = function (file, max = 1800) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("not a picture this browser can read")); };
    img.src = url;
  });
};

App._photoUrls = {};
App.photoUrl = function (name) {
  if (!App._photoUrls[name]) {
    App._photoUrls[name] = fetch(`/api/photos/${encodeURIComponent(name)}`)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(b => URL.createObjectURL(b))
      .catch(e => { delete App._photoUrls[name]; throw e; });
  }
  return App._photoUrls[name];
};

// the whole picture, over everything; a tap (or Escape) puts it away
App.showPhoto = async function (name) {
  const view = App.el(`<div class="mb-photo-view" title="Close"><img alt=""></div>`);
  const close = () => { view.remove(); document.removeEventListener("keydown", key, true); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  view.addEventListener("click", close);
  document.addEventListener("keydown", key, true);
  document.body.appendChild(view);
  try { view.querySelector("img").src = await App.photoUrl(name); } catch (e) { close(); App.toast("That photo isn't here yet"); }
};

App.toast = function (msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(App._toastTimer);
  App._toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
};

App.openModal = function (html) {
  document.getElementById("modal-panel").innerHTML = html;
  document.getElementById("modal-backdrop").classList.add("open");
  const first = document.querySelector("#modal-panel input, #modal-panel select, #modal-panel textarea");
  if (first) first.focus();
};
App.closeModal = function () {
  document.getElementById("modal-backdrop").classList.remove("open");
  document.getElementById("modal-panel").innerHTML = "";
};

// Resolve an ingredient name typed into a free-text field to an id,
// creating a plain "other" category ingredient on the fly if it doesn't
// exist yet -- shared by recipes.js and mealblock.js so a recipe/meal
// never blocks on ingredient bookkeeping. Mutates `ingredientsList` in
// place so the caller's cache stays in sync with what's now on the server.
App.resolveIngredientId = async function (name, unit, ingredientsList, later) {
  const existing = ingredientsList.find(i => (i.name || "").toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const res = await App.api("/api/ingredients", { method: "POST",
    body: { name, category: "other", default_unit: unit || "g", resolve: !later } });
  ingredientsList.push(res.ingredient);
  if (later) App.resolveLater(res.ingredient.id);
  return res.ingredient.id;
};

/* The USDA match (nutrition, portions, which list it belongs on) for a just-made ingredient,
 * found AFTER it's already on the screen -- one lookup at a time, never in the way of typing.
 * `onDone` runs once it's in (e.g. the list redraws: an item can move to the market). */
App._resolveQueue = Promise.resolve();
App.resolveLater = function (ingredientId, onDone) {
  App._resolveQueue = App._resolveQueue
    .then(() => App.api(`/api/ingredients/${ingredientId}/resolve`, { method: "POST" }))
    .catch(() => {})            // no confident match / no key: it still plans and shops fine
    .then(() => { if (onDone) onDone(); });
  return App._resolveQueue;
};

/* Where the phone is right now, for "stores near me" -- or null (no permission, no fix in 5 s, a
 * laptop without location): callers then fall back to the saved home. One fix serves 15 min. */
App._pos = null;
App.position = function () {
  if (App._pos && Date.now() - App._pos.at < 15 * 60 * 1000) return Promise.resolve(App._pos);
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => {
        resolve(App._pos = { lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now() });
        // near a different saved home: that one becomes active for every device (places.arrived)
        App.api("/api/places/here", { method: "POST", body: { lat: App._pos.lat, lon: App._pos.lon } })
          .then((r) => { if (r && r.switched) { App.toast(`Home: ${r.active.label}`); App.render && App.render(); } })
          .catch(() => {});
      },
      () => resolve(null), { timeout: 5000, maximumAge: 15 * 60 * 1000, enableHighAccuracy: false });
  });
};

/* In the shop: opening the app on a phone that is at the picked grocery store or farmer's market pulls
 * up the grocery list at that shop's section (Storm 2026-10-31). Judged like the shop watch: within
 * 400 m of the shop's map pin counts as inside. Once per open; if the list was already touched, or
 * there's no fix, nothing happens. Away from every saved home (300 m) and not at a shop: the list from the
 * top. At home nothing opens by itself: the plan shows today, and the whole week on Fridays (plan.js). */
App.listWhereIAm = async function () {
  // a FRESH fix (the shared one may be 15 min old, still at home), asked twice before giving up
  const fix = () => new Promise((ok) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }),
        () => ok(null), { timeout: 12000, maximumAge: 20000, enableHighAccuracy: true })
    : ok(null));
  const own = () => { try { const o = window.MealsAndroid && window.MealsAndroid.here && window.MealsAndroid.here(); return o ? JSON.parse(o) : null; } catch (e) { return null; } };
  // the page's own geolocation twice, then what the Android shell last saw (a stuck permission prompt can't block that)
  const pos = (await fix()) || (await fix()) || own();
  if (!pos) return;
  // which home is active only needs the server when the phone has moved a long way since it last said
  let said = null; try { said = JSON.parse(localStorage.getItem("meals.v1.said") || "null"); } catch (e) {}
  if (!said || Math.hypot((said.lat - pos.lat) * 111000, (said.lon - pos.lon) * 92000) > 2000) {
    App.api("/api/places/here", { method: "POST", body: pos }).catch(() => {});
    try { localStorage.setItem("meals.v1.said", JSON.stringify(pos)); } catch (e) {}
  }
  // the shops and homes barely change: asked for once an hour (each call on the phone is seconds of Python)
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("meals.v1.where") || "null"); } catch (e) {}
  if (!cached || Date.now() - cached.at > 3600_000) {
    const [r1, p1] = await Promise.all([App.api("/api/groceries/geofences").catch(() => null), App.api("/api/places").catch(() => null)]);
    if (r1 && p1) { cached = { at: Date.now(), r: r1, pl: p1 }; try { localStorage.setItem("meals.v1.where", JSON.stringify(cached)); } catch (e) {} }
  }
  const r = cached && cached.r, pl = cached && cached.pl;
  const rad = Math.PI / 180;
  const metres = (lat, lon) => {
    const a = Math.sin((lat - pos.lat) * rad / 2) ** 2 +
      Math.cos(pos.lat * rad) * Math.cos(lat * rad) * Math.sin((lon - pos.lon) * rad / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(a));
  };
  let best = null;
  for (const f of (r && r.fences) || []) {
    const d = metres(f.lat, f.lon);
    if (d <= 400 && (!best || d < best.d)) best = { d, kind: f.kind };
  }
  // out of the house (not within 300 m of any saved home) and not at a shop: still the list, from the top
  const homes = (pl && pl.places) || [];
  const away = homes.length && homes.every((h) => metres(h.lat, h.lon) > 300);
  if (!best && away) best = { d: 0, kind: "grocery" };
  if (!best || (App.plan && App.plan._listTouched)) return;
  if (App.state.view !== "plan") App.setView("plan");
  App.plan.toggleList(true);
  for (let i = 0; i < 20; i++) {            // the list draws a moment after it opens
    const sec = document.querySelector(`#list-panel .gp-section[data-list="${best.kind}"]`);
    if (sec) { sec.scrollIntoView({ block: "start" }); return; }
    await new Promise((ok) => setTimeout(ok, 250));
  }
};

/* Swipe a row sideways to remove it (phones) -- grocery rows, market lines, a meal's ingredient
 * lines. The direction is decided on the first ~10px of travel, so a vertical scroll is never
 * mistaken for a swipe and a tap is still a tap; a field being typed in keeps its touches. Past a
 * third of the row's width it flies off and `onRemove` runs. `wrap: false` moves the row itself
 * (no red bin behind it) for places whose code walks the rows as siblings, like a meal block;
 * `can()` false = this row can't be swiped (the blank line at the end of a meal). The day swipe
 * (plan.js) leaves anything inside `.swipe-row` alone. */
App.swipeAway = function (row, onRemove, opts = {}) {
  const wrapIt = opts.wrap !== false;
  const wrap = wrapIt ? App.el(`<div class="swipe"><span class="swipe-bin">${App.icon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>')}</span></div>`) : row;
  if (wrapIt) wrap.appendChild(row);
  row.classList.add("swipe-row");
  let x0 = 0, y0 = 0, dx = 0, mode = null;
  row.addEventListener("touchstart", (e) => {
    const field = e.target.closest("input:not([type=checkbox])");
    if (e.touches.length !== 1 || (field && field === document.activeElement) || (opts.can && !opts.can())) { mode = "no"; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null;
  }, { passive: true });
  row.addEventListener("touchmove", (e) => {
    if (mode === "no") return;
    const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
    if (mode === null) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      mode = Math.abs(mx) > Math.abs(my) * 1.2 ? "swipe" : "no";
      if (mode === "swipe") { row.style.transition = "none"; wrap.classList.add("swiping"); }
    }
    if (mode !== "swipe") return;
    dx = mx;
    row.style.transform = `translateX(${dx}px)`;
    if (!wrapIt) row.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / row.offsetWidth));
    wrap.classList.toggle("armed", Math.abs(dx) > row.offsetWidth / 3);
    wrap.classList.toggle("from-left", dx > 0);
  }, { passive: true });
  const end = () => {
    if (mode !== "swipe") { mode = null; return; }
    mode = null;
    row.style.transition = "";
    if (Math.abs(dx) > row.offsetWidth / 3) {
      row.style.transform = `translateX(${dx > 0 ? 110 : -110}%)`;
      wrap.style.height = wrap.offsetHeight + "px";
      requestAnimationFrame(() => wrap.classList.add("gone"));
      setTimeout(onRemove, wrapIt ? 0 : 200);
    } else {
      row.style.transform = "";
      row.style.opacity = "";
      wrap.classList.remove("swiping", "armed");
    }
  };
  row.addEventListener("touchend", end);
  row.addEventListener("touchcancel", end);
  return wrap;
};

App.icon = function (path) {
  return `<svg class="icon" viewBox="0 0 24 24">${path}</svg>`;
};

App.el = function (html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

App.esc = function (s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : s;
  return d.innerHTML;
};

App.setView = function (view) {
  if (App.state.view !== view && App.plan) App.plan._static = null;   // lists may have changed elsewhere: ask again next time
  App.state.view = view;
  document.body.dataset.view = view;
  document.querySelectorAll(".nav-icon").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  document.getElementById("back-btn").hidden = view === "plan";
  document.getElementById("brand").hidden = view !== "plan";
  document.getElementById("nav").innerHTML = "";
  App.render();
};

App.render = function (soft) {
  const body = document.getElementById("body");
  const mod = App[App.state.view];
  if (mod && typeof mod.render === "function") {
    mod.render(body, soft === true);
  } else {
    body.innerHTML = `<div class="empty-state">${App.icon('<circle cx="12" cy="12" r="9"/>')}<div>“${App.state.view}” isn't wired up yet.</div></div>`;
  }
};

// The top bar's shared slot. Secondary screens get a plain title; the plan
// puts its own date nav here.
App.setNav = function (html) {
  document.getElementById("nav").innerHTML = html;
  return document.getElementById("nav");
};

function typingInField(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

/* The third pane: a second copy of the app (?pane=<view>, topbar hidden) docked on the right, so
 * recipes / bulk / … can sit beside the plan. Same server, so the 5-second stamp poll below keeps
 * both copies current. The view and width are remembered. */
App.pane = {
  KEY_V: "meals.v1.pane", KEY_W: "meals.v1.paneW",
  _get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  _set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  _clamp(w) { return Math.max(260, Math.min(Math.round(window.innerWidth * 0.6), w)); },
  open(view) {
    const side = document.getElementById("side-pane"), frame = document.getElementById("sp-frame");
    view = view || this._get(this.KEY_V) || "recipes";
    side.hidden = false;
    document.getElementById("pane-handle").hidden = false;
    const w = Number(this._get(this.KEY_W));
    side.style.width = this._clamp(w || 460) + "px";
    if (frame.dataset.view !== view) { frame.dataset.view = view; frame.src = `/?pane=${view}`; }
    document.querySelectorAll("#sp-head [data-pane]").forEach(b => b.classList.toggle("on", b.dataset.pane === view));
    document.getElementById("pane-btn").classList.add("on");
    this._set(this.KEY_V, view);
    this._set("meals.v1.paneOpen", "1");
  },
  close() {
    document.getElementById("side-pane").hidden = true;
    document.getElementById("pane-handle").hidden = true;
    document.getElementById("pane-btn").classList.remove("on");
    this._set("meals.v1.paneOpen", null);
  },
  wire() {
    const side = document.getElementById("side-pane"), handle = document.getElementById("pane-handle");
    document.getElementById("pane-btn").addEventListener("click", () => side.hidden ? this.open() : this.close());
    document.getElementById("sp-close").addEventListener("click", () => this.close());
    document.getElementById("sp-head").addEventListener("click", (e) => {
      const b = e.target.closest("[data-pane]"); if (b) this.open(b.dataset.pane);
    });
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      document.getElementById("sp-frame").style.pointerEvents = "none";   // the iframe would eat the drag
      const move = (ev) => { side.style.width = this._clamp(window.innerWidth - ev.clientX) + "px"; };
      const up = () => {
        handle.classList.remove("drag");
        document.getElementById("sp-frame").style.pointerEvents = "";
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        this._set(this.KEY_W, String(side.offsetWidth));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => { this._set(this.KEY_W, null); side.style.width = this._clamp(460) + "px"; });
    if (this._get("meals.v1.paneOpen")) this.open();
  },
};

function init() {
  const paneView = new URLSearchParams(location.search).get("pane");
  if (paneView) document.documentElement.classList.add("pane-mode");
  else App.pane.wire();
  document.querySelectorAll(".nav-icon").forEach(btn => {
    btn.addEventListener("click", () => App.setView(btn.dataset.view));
  });
  document.getElementById("back-btn").addEventListener("click", () => App.setView("plan"));
  // the Pantry lives in the list panel (groceriespanel.js): open the list, then it
  document.getElementById("pantry-btn").addEventListener("click", () => {
    const open = () => { App.plan.toggleList(true); App.groceriesPanel.openPantry(); };
    if (App.state.view !== "plan") { App.setView("plan"); setTimeout(open, 60); return; }
    open();
  });
  document.getElementById("list-btn").addEventListener("click", () => {
    if (App.state.view !== "plan") { App.setView("plan"); setTimeout(() => App.plan.toggleList(true), 60); return; }
    App.plan.toggleList();
  });

  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") App.closeModal();
  });

  document.addEventListener("keydown", (e) => {
    // Escape closes a modal; it deliberately does NOT hide the grocery
    // list any more -- the list is docked, and Escape belongs to whatever
    // line is being typed (mealblock.js ends the line with it).
    if (e.key === "Escape") {
      if (document.getElementById("modal-backdrop").classList.contains("open")) App.closeModal();
      return;
    }
    // "g" pulls up the grocery list from anywhere in the plan -- but not
    // while a letter is being typed into a meal name or an ingredient.
    const isG = e.key === "g" || e.key === "G";
    if (isG && (e.ctrlKey || !typingInField(e)) && !e.altKey && !e.metaKey) {
      e.preventDefault();
      if (App.state.view !== "plan") { App.setView("plan"); setTimeout(() => App.plan.toggleList(true), 60); }
      else App.plan.toggleList();
    }
  });

  // Phone gestures (touch only; a mouse never fires these).
  // 1. Scrolling up or down puts the keyboard away: a vertical drag of more than ~12 px while a field has focus
  //    blurs it (Storm 2026-10-31: "if I swipe up or down to see more stuff I want the keyboard to go away").
  // 2. The list sheet follows a finger pulled down from its top and closes; a pull down on the top bar opens it.
  {
    let x0 = 0, y0 = 0, on = false, pull = null;
    const typing = () => { const e = document.activeElement; return e && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName) && e.type !== "checkbox" ? e : null; };
    const phone = () => window.matchMedia("(max-width: 760px)").matches;
    document.addEventListener("touchstart", (e) => {
      on = e.touches.length === 1; if (!on) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      const lp = document.getElementById("list-panel"), open = App.plan && App.plan._listOpen;
      pull = null;
      if (phone() && open && lp && lp.contains(e.target) && lp.scrollTop <= 0) pull = "close";
      else if (phone() && e.target.closest && e.target.closest("#topbar")) pull = open ? "shut" : "open";   // the top bar: swipe down opens the list, or closes it when it is open
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!on) return;
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dy) < 12 || Math.abs(dy) < Math.abs(dx) * 1.5) return;
      const f = typing();
      if (f && !(f.tagName === "TEXTAREA" && f.scrollHeight > f.clientHeight + 2)) f.blur();
      if (pull === "close" && dy > 0) {
        const lp = document.getElementById("list-panel");
        if (lp.scrollTop > 0) { pull = null; lp.style.transform = ""; return; }
        lp.style.transition = "none"; lp.style.transform = `translateY(${Math.round(dy * 0.8)}px)`;
      }
    }, { passive: true });
    const end = (e) => {
      if (!on) return; on = false;
      const dy = (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : y0) - y0;
      const lp = document.getElementById("list-panel");
      if (pull === "close" && lp) {
        lp.style.transition = "transform .18s ease";
        if (dy > 110) { lp.style.transform = "translateY(100%)"; setTimeout(() => { App.plan.toggleList(false); lp.style.transition = ""; lp.style.transform = ""; }, 170); }
        else lp.style.transform = "";
        setTimeout(() => { if (lp.style.transform === "") lp.style.transition = ""; }, 220);
      } else if (pull === "open" && dy > 60) App.plan.toggleList(true);
      else if (pull === "shut" && dy > 40) App.plan.toggleList(false);
      pull = null;
    };
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  }

  // (the phone answers from Python in its own browser: every call there costs seconds on the one thread, so it makes none it doesn't need)
  const onPhonePy = typeof loadPyodide === "function";
  if (!onPhonePy) App.api("/api/meta").catch(() => {}); // warms the connection, surfaces a dead server early

  App.setView(paneView || "plan");
  if (!paneView && (window.MealsAndroid || /Mobi|iPhone|Android/.test(navigator.userAgent))) {
    // on open, and again whenever the app comes back to the front (a shop is reached with the app already open)
    let lastLook = 0;
    const look = () => { if (Date.now() - lastLook < 60000) return; lastLook = Date.now(); App.listWhereIAm().catch(() => {}); };
    look();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") look(); });
  }

  // recipes handed over by the Recipes app: files in the inbox (laptop) or an intent text (Android shell)
  App.sharedIn = (text) => App.recipes.importShared(text);
  // laptop: the Recipes app drops a file here whenever a recipe is saved; look now and every 20 s
  // The server takes the files in itself (inbox_import.py, also on a file watcher); this just asks it to
  // look now, and shows the result. Not in a side pane: one window asking is enough.
  const pickUp = () => App.api("/api/inbox").then((r) => {
    if (r.ops && App.bangers) App.bangers._refresh();         // stars / deletes / new recipes from over there
    if (r.ops) App.toast("Recipes updated from the Recipes app");
  }).catch(() => {});
  if (!paneView && !onPhonePy) pickUp();   // once now; after that the server tells us (below)

  // phone / web build: coming back to the front after a new version was published reloads the page.
  // (An Android shell resumes the SAME page, so "closing and reopening" never fetched the update.)
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    let mine = null;
    const stamp = () => fetch("version.txt", { cache: "no-store" }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    stamp().then((t) => { mine = t; });
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState !== "visible" || mine === null) return;
      const t = await stamp();
      if (t && t !== mine) location.reload();
    });
  }

  // laptop: the phone's edits (through Dropbox), the Recipes app and the importer all change files here.
  // The server watches them (inotify, no polling) and holds one event stream open to each window: it
  // sends "data" / "inbox" the moment something changes, so an idle window does nothing at all.
  // Never redraws under a focused field. (The phone build has its own Dropbox long-poll in bridge.js.)
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    let wanted = false;
    const redrawIfIdle = () => {
      const a = document.activeElement;
      if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) { wanted = true; return; }
      wanted = false;
      App.render(true);        // a soft redraw: does nothing when what's on screen is already right
    };
    document.addEventListener("focusout", () => setTimeout(() => { if (wanted) redrawIfIdle(); }, 300));

    // no file watching here (or the stream is refused): the old slow look, every 30 s
    const slowPoll = () => {
      let seen = null;
      const look = () => fetch("/api/stamp").then((r) => r.json()).then((r) => r.stamp).catch(() => seen);
      look().then((t) => { seen = t; });
      setInterval(async () => {
        const t = await look();
        if (seen !== null && t !== seen) { seen = t; redrawIfIdle(); }
        if (!paneView) pickUp();
      }, 30000);
    };
    if (onPhonePy) { /* the phone hears about changes from its own Dropbox watch (bridge.js): no polling of Python */ }
    else if (window.EventSource) {
      const es = new EventSource("/api/events");
      let opened = false, quiet;
      es.addEventListener("hello", () => { if (opened) { redrawIfIdle(); if (!paneView) pickUp(); } opened = true; });
      es.addEventListener("data", () => { clearTimeout(quiet); quiet = setTimeout(redrawIfIdle, 250); });   // a save is a burst of writes
      es.addEventListener("inbox", () => { if (!paneView) pickUp(); });
      es.onerror = () => { if (es.readyState === EventSource.CLOSED) slowPoll(); };   // refused: fall back
    } else slowPoll();
  }
}

document.addEventListener("DOMContentLoaded", init);
