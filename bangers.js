/* Bangers: the best meals, kept per meal type in a small drawer.
 *
 * A little tab sits bottom-left on every view; it opens a panel with
 * Breakfast / Lunch / Dinner lists. A row expands to its ingredients and
 * per-serving nutrition. The + in a section header opens a name box that
 * suggests from the saved recipes (the same dropdown the meal blocks use);
 * the x on a row removes it from the list -- the recipe itself is kept.
 */
window.App = window.App || {};

App.bangers = {
  _data: [],
  _open: false,
  _expanded: new Set(),
  _adding: null,       // meal whose + box is showing
  _recipes: [],

  MEALS: [
    ["breakfast", "Breakfast", '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
    ["lunch", "Lunch", '<path d="M3 11h18a9 9 0 0 0-18 0Z"/><path d="M3 15h18M5 19h14"/>'],
    ["dinner", "Dinner", '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'],
  ],
  FLAME: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4 2-6 .5 2.5 2 4.9 4 6.5 2 1.7 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.4 1-3a2.5 2.5 0 0 0 2.5 2.5Z"/>',

  init() {
    this._dock = document.getElementById("bangers-dock");
    this._draw();
    this._refresh();
  },

  async _refresh() {
    const [b, r] = await Promise.all([App.api("/api/bangers"), App.api("/api/recipes")]);
    this._data = b.bangers;
    this._recipes = r.recipes;
    this._draw();
    document.dispatchEvent(new Event("bangers-changed"));
  },

  find(meal, recipeId) { return this._data.find(b => b.meal === meal && b.recipe_id === recipeId) || null; },

  async addRecipe(meal, recipeId) {
    await App.api("/api/bangers", { method: "POST", body: { meal, recipe_id: recipeId } });
    await this._refresh();
  },

  async remove(id) {
    const res = await App.api(`/api/bangers/${id}`, { method: "DELETE" });
    this._data = res.bangers;
    this._draw();
    document.dispatchEvent(new Event("bangers-changed"));
  },

  _toggle(force) {
    this._open = force === undefined ? !this._open : force;
    this._adding = null;
    App.ingSuggest.close();
    this._draw();
  },

  _draw() {
    const dock = this._dock;
    if (!dock) return;
    dock.className = this._open ? "open" : "";
    const sections = this.MEALS.map(([meal, label, icon]) => {
      const items = this._data.filter(b => b.meal === meal);
      return `
        <div class="bg-sec" data-meal="${meal}">
          <div class="bg-sec-head">${App.icon(icon)}<span>${label}</span><span class="bg-n num">${items.length || ""}</span>
            <button class="icon-btn bg-add" title="Add a banger">${App.icon('<path d="M12 5v14M5 12h14"/>')}</button></div>
          ${this._adding === meal ? `<input class="bg-input" placeholder="meal name…" autocomplete="off" spellcheck="false">` : ""}
          ${items.map(b => this._rowHtml(b)).join("") || (this._adding === meal ? "" : `<div class="bg-empty">none yet</div>`)}
        </div>`;
    }).join("");
    dock.innerHTML = `
      ${this._open ? `<div class="bg-panel">${sections}</div>` : ""}
      <button class="bg-tab" title="Bangers — the best meals">${App.icon(this.FLAME)}<span>Bangers</span></button>`;

    dock.querySelector(".bg-tab").addEventListener("click", () => this._toggle());
    dock.querySelectorAll(".bg-sec").forEach(sec => {
      const meal = sec.dataset.meal;
      sec.querySelector(".bg-add").addEventListener("click", () => {
        this._adding = this._adding === meal ? null : meal;
        this._draw();
      });
      const input = sec.querySelector(".bg-input");
      if (input) this._wireInput(input, meal);
    });
    dock.querySelectorAll(".bg-row").forEach(row => {
      row.querySelector(".bg-row-main").addEventListener("click", () => {
        const id = row.dataset.id;
        this._expanded.has(id) ? this._expanded.delete(id) : this._expanded.add(id);
        this._draw();
      });
      row.querySelector(".bg-x").addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.remove(row.dataset.id);
      });
    });
  },

  _rowHtml(b) {
    const open = this._expanded.has(b.id);
    const n = b.nutrition || {};
    const stats = b.unknown ? `nutrition unknown for ${b.unknown} ingredient${b.unknown === 1 ? "" : "s"}`
      : `${Math.round(n.calories_kcal || 0)} kcal · ${(n.protein_g || 0).toFixed(1)}g protein · ${(n.fiber_g || 0).toFixed(1)}g fiber`;
    return `
      <div class="bg-row ${open ? "open" : ""}" data-id="${b.id}">
        <div class="bg-row-main">
          ${App.icon('<path d="m9 6 6 6-6 6"/>')}
          <span class="bg-name">${App.esc(b.name)}</span>
          <button class="icon-btn bg-x" title="Remove from bangers">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>
        ${open ? `<div class="bg-detail">
          <div class="bg-stats num">${stats} <span class="dim">/ serving</span></div>
          ${b.lines.length ? `<ul>${b.lines.map(l => `<li><span>${App.esc(l.name)}</span><span class="num dim">${App.esc(_bgAmount(l))}</span></li>`).join("")}</ul>` : `<div class="bg-empty">no ingredients saved</div>`}
          ${b.notes ? `<div class="bg-notes">${App.esc(b.notes)}</div>` : ""}
        </div>` : ""}
      </div>`;
  },

  _wireInput(input, meal) {
    input.focus();
    App.ingSuggest.attach(input, {
      local: () => {
        const have = new Set(this._data.filter(b => b.meal === meal).map(b => b.recipe_id));
        return this._recipes.filter(r => !have.has(r.id)).map(r => ({ name: r.name, recipe_id: r.id }));
      },
      onPick: (item) => this._add(meal, item.recipe_id),
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const t = input.value.trim().toLowerCase();
        const r = this._recipes.find(x => x.name.toLowerCase() === t);
        if (r) this._add(meal, r.id); else App.toast("No saved meal with that name");
      } else if (e.key === "Escape" && !App.ingSuggest.isOpen()) {
        this._adding = null;
        this._draw();
      }
    });
    input.focus();
  },

  async _add(meal, recipeId) {
    this._adding = null;
    await this.addRecipe(meal, recipeId);
  },
};

function _bgAmount(l) {
  const q = Math.round(l.qty * 100) / 100;
  return `${q}${l.unit && l.unit !== "each" ? " " + l.unit : ""}`;
}

document.addEventListener("DOMContentLoaded", () => App.bangers.init());
