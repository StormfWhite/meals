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
App.resolveIngredientId = async function (name, unit, ingredientsList) {
  const existing = ingredientsList.find(i => i.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const res = await App.api("/api/ingredients", { method: "POST", body: { name, category: "other", default_unit: unit || "g" } });
  ingredientsList.push(res.ingredient);
  return res.ingredient.id;
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
