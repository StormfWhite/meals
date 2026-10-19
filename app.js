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
  if (res.status === 204) return null;
  return res.json();
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
  const existing = ingredientsList.find(i => i.name.toLowerCase() === name.toLowerCase());
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
  App.state.view = view;
  document.querySelectorAll(".nav-icon").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  document.getElementById("back-btn").hidden = view === "plan";
  document.getElementById("brand").hidden = view !== "plan";
  document.getElementById("nav").innerHTML = "";
  App.render();
};

App.render = function () {
  const body = document.getElementById("body");
  const mod = App[App.state.view];
  if (mod && typeof mod.render === "function") {
    mod.render(body);
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

function init() {
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

  App.api("/api/meta").catch(() => {}); // warms the connection, surfaces a dead server early

  App.setView("plan");
}

document.addEventListener("DOMContentLoaded", init);
