/* History — three sub-views: a weekly retrospective (log what actually
 * happened), Ingredients (rolling averages + nudges), Meals (skip rate).
 * Logging is deliberately low-friction: one click on an outcome button,
 * no required numbers -- see learning.py's auto-estimate. */
window.App = window.App || {};

const OUTCOME_LABELS = { ran_out: "Ran out", leftover: "Had leftovers", used_exactly: "Used exactly right" };

App.history = {
  _tab: "retrospective",
  _weekStart: null,
  _recipes: [],
  _ingredients: [],

  async render(body) {
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    if (!this._weekStart) {
      const b = await App.api("/api/board");
      this._weekStart = b.week_start;
    }
    const [recipesRes, ingredientsRes] = await Promise.all([App.api("/api/recipes"), App.api("/api/ingredients")]);
    this._recipes = recipesRes.recipes;
    this._ingredients = ingredientsRes.ingredients;
    this._draw(body);
  },

  _draw(body) {
    body.innerHTML = `
      <div class="board-toolbar">
        <div class="seg" id="tab-seg">
          <button data-tab="retrospective" class="${this._tab === "retrospective" ? "active" : ""}">Weekly retrospective</button>
          <button data-tab="ingredients" class="${this._tab === "ingredients" ? "active" : ""}">Ingredients</button>
          <button data-tab="meals" class="${this._tab === "meals" ? "active" : ""}">Meals</button>
        </div>
      </div>
      <div class="pad" id="history-body"></div>
    `;
    const out = body.querySelector("#history-body");
    if (this._tab === "retrospective") this._drawRetrospective(out);
    else if (this._tab === "ingredients") this._drawIngredients(out);
    else this._drawMeals(out);

    body.querySelector("#tab-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      this._tab = btn.dataset.tab;
      this._draw(body);
    });
  },

  async _drawRetrospective(out) {
    out.innerHTML = `<div class="loading-state"><div class="spin"></div>Loading…</div>`;
    const [week, groceriesRes] = await Promise.all([
      App.api(`/api/board?week=${this._weekStart}`),
      App.api(`/api/groceries/${this._weekStart}`),
    ]);
    out.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <button class="icon-btn" id="rw-prev">${App.icon('<path d="m15 18-6-6 6-6"/>')}</button>
        <div class="field-label">${_fmtRange(this._weekStart)}</div>
        <button class="icon-btn" id="rw-next">${App.icon('<path d="m9 18 6-6-6-6"/>')}</button>
      </div>
      <div class="field-label" style="margin-bottom:6px;">Meals</div>
      <div id="rw-meals" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;"></div>
      <div class="field-label" style="margin-bottom:6px;">Groceries</div>
      <div id="rw-groceries" style="display:flex;flex-direction:column;gap:6px;"></div>
    `;
    out.querySelector("#rw-prev").addEventListener("click", () => { this._weekStart = _shift(this._weekStart, -7); this._drawRetrospective(out); });
    out.querySelector("#rw-next").addEventListener("click", () => { this._weekStart = _shift(this._weekStart, 7); this._drawRetrospective(out); });

    const mealsWrap = out.querySelector("#rw-meals");
    const slotEntries = Object.entries(week.slots);
    if (slotEntries.length === 0) {
      mealsWrap.innerHTML = `<div class="modal-hint">Nothing planned that week.</div>`;
    }
    slotEntries.forEach(([slotKey, slot]) => {
      const [date, mealKey] = slotKey.split(":"); const meal = mealKey.split("~")[0];
      const recipe = this._recipes.find(r => r.id === slot.recipe_id);
      const row = App.el(`<div class="item-row">
        <span class="name">${_fmtShort(date)} ${meal}</span>
        <span class="meta">${_esc(recipe ? recipe.name : "(deleted)")}</span>
        <button class="btn-ghost log-btn" data-outcome="eaten">Eaten</button>
        <button class="btn-ghost log-btn" data-outcome="skipped">Skipped</button>
      </div>`);
      row.querySelectorAll(".log-btn").forEach(btn => btn.addEventListener("click", async () => {
        await App.api(`/api/learning/meals/${slot.recipe_id}/log`, { method: "POST", body: { week: this._weekStart, slot: slotKey, outcome: btn.dataset.outcome } });
        App.toast(`Logged: ${btn.dataset.outcome}`);
      }));
      mealsWrap.appendChild(row);
    });

    const grocWrap = out.querySelector("#rw-groceries");
    const bought = groceriesRes.items.filter(i => i.bought_qty_g !== null && i.bought_qty_g !== undefined);
    if (bought.length === 0) {
      grocWrap.innerHTML = `<div class="modal-hint">No purchases logged yet for this week — mark items as bought in Groceries first.</div>`;
    }
    bought.forEach(item => {
      const row = App.el(`<div class="item-row" style="flex-wrap:wrap;">
        <span class="name">${_esc(item.name)}</span>
        <span class="meta">bought ${item.unit_label}</span>
        <button class="btn-ghost log-btn" data-outcome="ran_out">Ran out</button>
        <button class="btn-ghost log-btn" data-outcome="leftover">Had leftovers</button>
        <button class="btn-ghost log-btn" data-outcome="used_exactly">Used exactly</button>
      </div>`);
      row.querySelectorAll(".log-btn").forEach(btn => btn.addEventListener("click", async () => {
        await App.api(`/api/learning/ingredients/${item.ingredient_id}/log`, { method: "POST", body: { week: this._weekStart, outcome: btn.dataset.outcome } });
        App.toast(`Logged: ${OUTCOME_LABELS[btn.dataset.outcome]}`);
      }));
      grocWrap.appendChild(row);
    });
  },

  async _drawIngredients(out) {
    out.innerHTML = `<div class="loading-state"><div class="spin"></div>Loading…</div>`;
    const nudgesRes = await App.api("/api/learning/nudges");
    const entries = await Promise.all(this._ingredients.map(async i => ({ ing: i, entry: await App.api(`/api/learning/ingredients/${i.id}`) })));
    const withHistory = entries.filter(e => e.entry.events && e.entry.events.length > 0);

    out.innerHTML = "";
    if (nudgesRes.nudges.length) {
      const banners = App.el(`<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;"></div>`);
      nudgesRes.nudges.forEach(n => {
        const b = App.el(`<div class="notice" style="flex-direction:row;align-items:center;justify-content:flex-start;padding:10px 12px;text-align:left;gap:9px;">
          ${App.icon('<path d="M12 9v4M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/>')}
          <span style="flex:1;font-size:12.5px;">${_esc(n.text)}</span>
          <button class="icon-btn dismiss-btn">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>`);
        b.querySelector(".dismiss-btn").addEventListener("click", () => b.remove());
        banners.appendChild(b);
      });
      out.appendChild(banners);
    }

    if (withHistory.length === 0) {
      out.appendChild(App.el(`<div class="empty-state">${App.icon('<path d="M3 12a9 9 0 1 0 3-6.7"/>')}<div>Log grocery outcomes from the weekly retrospective to build history here.</div></div>`));
      return;
    }
    withHistory.forEach(({ ing, entry }) => {
      const pct = entry.rolling_avg_ratio !== null ? Math.round(entry.rolling_avg_ratio * 100) : null;
      const row = App.el(`<div class="item-row">
        <span class="name">${_esc(ing.name)}</span>
        <span class="meta">${pct !== null ? `typically ${pct}% used` : ""} · ${entry.events.length} log${entry.events.length === 1 ? "" : "s"}</span>
      </div>`);
      row.addEventListener("click", () => this._openHistoryModal(ing.name, entry.events));
      out.appendChild(row);
    });
  },

  _openHistoryModal(name, events) {
    // ingredient events carry actual/planned grams; meal events (eaten/skipped) don't -- show whichever detail this event shape has
    const rows = events.slice().reverse().map(e => `<div class="dropped-row"><span class="p">${e.week}</span><span class="t">${e.outcome}</span><span class="t dim">${e.actual_qty_g !== undefined ? `${Math.round(e.actual_qty_g)}g actual / ${Math.round(e.planned_qty_g)}g planned` : (e.slot || "")}</span></div>`).join("");
    App.openModal(`
      <h2>${_esc(name)} history
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <div class="dropped-list">${rows || '<div class="modal-hint">No events.</div>'}</div>
    `);
  },

  async _drawMeals(out) {
    out.innerHTML = `<div class="loading-state"><div class="spin"></div>Loading…</div>`;
    const entries = await Promise.all(this._recipes.map(async r => ({ recipe: r, entry: await App.api(`/api/learning/meals/${r.id}`) })));
    const withHistory = entries.filter(e => (e.entry.frequency && e.entry.frequency.count > 0) || (e.entry.events && e.entry.events.length > 0));
    out.innerHTML = "";
    if (withHistory.length === 0) {
      out.appendChild(App.el(`<div class="empty-state">${App.icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>')}<div>Schedule and log meals to see stats here -- how often you eat something, when you last had it, and any ingredient it's crept up or down on.</div></div>`));
      return;
    }
    // most-frequently-eaten first, so patterns worth knowing about surface at the top
    withHistory.sort((a, b) => (b.entry.frequency.count || 0) - (a.entry.frequency.count || 0));
    withHistory.forEach(({ recipe, entry }) => {
      const freq = entry.frequency || { count: 0, last_date: null };
      const skipped = (entry.events || []).filter(e => e.outcome === "skipped").length;
      const metaParts = [];
      if (freq.count > 0) {
        metaParts.push(`eaten ${freq.count} time${freq.count === 1 ? "" : "s"} · last ${_fmtShort(freq.last_date)}`);
      }
      if (entry.events && entry.events.length > 0) {
        metaParts.push(`skipped ${skipped} of the last ${entry.events.length}`);
      }
      const row = App.el(`<div class="item-row" style="flex-wrap:wrap;">
        <span class="name">${_esc(recipe.name)}</span>
        <span class="meta">${metaParts.join(" · ")}</span>
        ${(entry.trend || []).map(t => `<span class="chip trend-${t.direction}">${t.direction === "up" ? "▲" : "▼"} ${_esc(t.name)} ${t.pct_change > 0 ? "+" : ""}${t.pct_change}%</span>`).join("")}
      </div>`);
      if (entry.events && entry.events.length > 0) {
        row.style.cursor = "pointer";
        row.addEventListener("click", (e) => { if (!e.target.closest(".chip")) this._openHistoryModal(recipe.name, entry.events); });
      }
      out.appendChild(row);
    });
  },
};

function _shift(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function _fmtRange(weekStart) {
  const s = new Date(weekStart + "T00:00:00");
  const e = new Date(s); e.setDate(e.getDate() + 6);
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
function _fmtShort(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
}
function _esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
