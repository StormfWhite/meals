/* Groceries — auto-aggregated from the week's planned recipes (leftover
 * batches counted once, see groceries.py). Two real sections plus an
 * "Unsorted" bucket for anything not yet tagged Grocery Store vs Farmer's
 * Market. The allocation bar reads: bad = not enough bought yet, warn =
 * bought more than the plan needs (possible waste), good = matches. */
window.App = window.App || {};

const SECTION_LABELS = { grocery_store: "Grocery Store", farmers_market: "Farmer's Market" };

App.groceries = {
  _weekStart: null,
  _items: [],

  async render(body) {
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    if (!this._weekStart) {
      const b = await App.api("/api/board");
      this._weekStart = b.week_start;
    }
    await this._load(body);
  },

  async _load(body) {
    const res = await App.api(`/api/groceries/${this._weekStart}/allocation`);
    this._items = res.items;
    this._draw(body);
  },

  _draw(body) {
    body.innerHTML = `
      <div class="board-toolbar">
        <button class="icon-btn" id="prev-week">${App.icon('<path d="m15 18-6-6 6-6"/>')}</button>
        <div class="field-label" style="min-width:140px;">${_fmtRange(this._weekStart)}</div>
        <button class="icon-btn" id="next-week">${App.icon('<path d="m9 18 6-6-6-6"/>')}</button>
      </div>
      <div class="pad">
        <div class="modal-hint" style="margin-bottom:10px;">
          Bar reads: <span style="color:var(--bad);">not enough bought yet</span> ·
          <span style="color:var(--good);">matches the plan</span> ·
          <span style="color:var(--warn);">bought more than needed</span>
        </div>
        <div id="sections" style="display:flex;flex-direction:column;gap:18px;"></div>
      </div>
    `;
    const sections = body.querySelector("#sections");
    const unsorted = this._items.filter(i => !i.section);
    if (unsorted.length) sections.appendChild(this._section(null, "Unsorted", unsorted));
    sections.appendChild(this._section("grocery_store", "Grocery Store", this._items.filter(i => i.section === "grocery_store")));
    sections.appendChild(this._section("farmers_market", "Farmer's Market", this._items.filter(i => i.section === "farmers_market")));

    body.querySelector("#prev-week").addEventListener("click", () => { this._weekStart = _shift(this._weekStart, -7); this._load(body); });
    body.querySelector("#next-week").addEventListener("click", () => { this._weekStart = _shift(this._weekStart, 7); this._load(body); });
  },

  _section(key, label, items) {
    const wrap = App.el(`<div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div class="field-label" style="flex:1;">${label} <span class="dim">(${items.length})</span></div>
        ${key ? `<button class="icon-btn copy-btn" title="Copy list">${App.icon('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>')}</button>` : ""}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;" class="rows"></div>
    </div>`);
    const rows = wrap.querySelector(".rows");
    if (items.length === 0) {
      rows.appendChild(App.el(`<div class="modal-hint">Nothing here.</div>`));
    } else {
      items.forEach(it => rows.appendChild(this._row(it)));
    }
    if (key) {
      wrap.querySelector(".copy-btn").addEventListener("click", async () => {
        const text = await (await fetch(`/api/groceries/${this._weekStart}/export?section=${key}`)).text();
        navigator.clipboard.writeText(text).then(() => App.toast("Copied"));
      });
    }
    return wrap;
  },

  _row(item) {
    const hasBought = item.bought_qty_g !== null && item.bought_qty_g !== undefined;
    let pct = 0, cls = "";
    if (hasBought) {
      pct = Math.min(100, (item.claimed_qty_g / item.planned_qty_g) * 100);
      if (item.overcommitted_g > 0) { cls = "bad"; }
      else if (item.unclaimed_qty_g > 0) { cls = "warn"; pct = 100; }
      else { cls = "good"; pct = 100; }
    }
    const row = App.el(`<div class="item-row" style="flex-wrap:wrap;">
      <label class="check"><input type="checkbox" class="chk" ${item.checked ? "checked" : ""}><span class="box">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span></label>
      <span class="name" style="min-width:110px;">${_esc(item.name)}</span>
      <span class="meta" style="flex:0;white-space:nowrap;">need ${_esc(item.unit_label)}</span>
      <input class="bought-input" type="number" step="any" placeholder="bought (g)" value="${hasBought ? item.bought_qty_g : ""}" style="width:100px;">
      <div class="bar ${cls}" style="min-width:80px;"><i style="width:${pct}%;"></i></div>
      ${hasBought && item.unclaimed_qty_g > 0 ? `<span class="meta" style="color:var(--warn);">+${item.unclaimed_qty_g}g extra</span>` : ""}
      ${hasBought && item.overcommitted_g > 0 ? `<span class="meta" style="color:var(--bad);">short ${item.overcommitted_g}g</span>` : ""}
      <select class="section-select">
        <option value="" ${!item.section ? "selected" : ""}>Unsorted</option>
        <option value="grocery_store" ${item.section === "grocery_store" ? "selected" : ""}>Grocery Store</option>
        <option value="farmers_market" ${item.section === "farmers_market" ? "selected" : ""}>Farmer's Market</option>
      </select>
    </div>`);

    row.querySelector(".chk").addEventListener("change", async (e) => {
      await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}`, { method: "PUT", body: { checked: e.target.checked } });
    });
    row.querySelector(".bought-input").addEventListener("change", async (e) => {
      const val = e.target.value === "" ? null : Number(e.target.value);
      await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}`, { method: "PUT", body: { bought_qty_g: val } });
      this._load(document.getElementById("body"));
    });
    row.querySelector(".section-select").addEventListener("change", async (e) => {
      await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}/section`, { method: "POST", body: { section: e.target.value || null } });
      this._load(document.getElementById("body"));
    });
    return row;
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
function _esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
