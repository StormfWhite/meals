/* Bulk makes (bulk.py) -- a big pot of something put straight into the fridge, the dry shelf or
 * the freezer, then drawn from as an ingredient of meals ("1 cup black beans"). Storm 2026-10-25.
 *
 * One screen, two halves: the pot being made on the left (name, what goes in, how much it makes,
 * where it goes), and everything made in bulk on the right -- what's on hand of it, what one unit
 * carries, and the pot it last came from (↻ puts that pot back on the left). Lines walk like a
 * meal block's: name → amount → a new line, the amount is one field ("1 lb", "2 cups"). */
window.App = window.App || {};

const BK_POT = '<path d="M4 10h16v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z"/><path d="M2 10h20"/><path d="M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2"/>';
const BK_AGAIN = '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>';
const BK_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const BK_UNDO = '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>';

App.bulk = {
  _ingredients: [],
  _data: null,
  _where: "freezer",
  _draft: null,          // the left side survives leaving the screen and coming back

  async render(body) {
    App.setNav(`<span class="plan-date">${App.icon(BK_POT)} Bulk</span>`);
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    const [ings, data, recs] = await Promise.all([App.api("/api/ingredients"), App.api("/api/bulk"), App.api("/api/recipes")]);
    this._ingredients = ings.ingredients;
    this._recipes = recs.recipes;
    this._data = data;
    body.innerHTML = `<div class="bk">
      <section class="bk-make"></section>
      <section class="bk-side"><div class="bk-items"></div><div class="bk-log"></div></section>
    </div>`;
    this._body = body;
    this._drawMake(this._draft);
    this._drawItems();
  },

  // ── the pot being made ─────────────────────────────────────────────
  _drawMake(draft) {
    const box = this._body.querySelector(".bk-make");
    const d = draft || { name: "", lines: [], yield_text: "", where: this._where, date: _bkToday() };
    this._where = d.where;
    box.innerHTML = `
      <div class="bk-head">
        <span class="bk-pot">${App.icon(BK_POT)}</span>
        <input class="bk-name" placeholder="What's being made — black beans, stock, sauce…" spellcheck="false" autocomplete="off" value="${App.esc(d.name)}">
        <input class="bk-date num" type="date" value="${d.date}" title="Made on">
        <span class="gp-stock-pick bk-where">
          <button class="icon-btn where-fridge" data-where="fridge" title="The whole pot goes in the fridge">${App.icon(GP_FRIDGE)}</button>
          <button class="icon-btn where-pantry" data-where="pantry" title="The whole pot goes on the dry shelf">${App.icon(GP_DRY)}</button>
          <button class="icon-btn where-freezer" data-where="freezer" title="The whole pot goes in the freezer">${App.icon(GP_SNOW)}</button>
        </span>
      </div>
      <div class="bk-rows"></div>
      <div class="bk-foot">
        <input class="bk-yield" placeholder="makes — 8 cups · 3 lb · 6 blocks of 1 lb" title="How much it makes. Blank = the weight of what goes in" spellcheck="false" value="${App.esc(d.yield_text)}">
        <button class="btn-primary bk-go" title="Make it — into the ${d.where}, its ingredients out of the kitchen">${App.icon(BK_CHECK)}</button>
      </div>
      <div class="bk-sum dim num"></div>`;
    const rows = box.querySelector(".bk-rows");
    (d.lines.length ? d.lines : []).forEach(l => rows.appendChild(this._row(l)));
    this._ensureBlank();
    rows.addEventListener("focusout", () => setTimeout(() => this._ensureBlank(), 0));

    const name = box.querySelector(".bk-name");
    // an existing bulk item picked with nothing typed under it: its last pot comes back
    name.addEventListener("change", () => { again(); this._saveDraft(); });
    // Fills like a meal's name does -- as it's typed, the lines it was last made with. The bulk
    // pot of that name comes first (its yield and place too), else the meal recipe: a bulk
    // French onion soup isn't the meal one (Storm 2026-10-26). Lines typed by hand are never
    // replaced; lines a name filled in follow the name.
    let filledFrom = null;
    const again = () => {
      const key = name.value.trim().toLowerCase();
      if (!key || key === filledFrom || (!filledFrom && this._readRows().length)) return;
      const it = this._data.items.find(i => i.name.toLowerCase() === key);
      const rec = !it && (this._recipes || []).find(r => r.name.toLowerCase() === key);
      if (!it && !rec) return;
      filledFrom = key;
      if (it) this._fillRows(it.last.lines, it.last.yield_text || "", it.last.where);
      else this._fillRows(rec.last_ingredients || rec.ingredients);
    };
    name.addEventListener("input", again);
    App.ingSuggest.attach(name, {
      local: () => this._data.items.map(i => ({ name: i.name, reason: Object.keys(i.have).length ? "on hand" : "made before" }))
        .concat((this._recipes || []).filter(r => !this._data.items.some(i => i.name.toLowerCase() === r.name.toLowerCase()))
          .map(r => ({ name: r.name, reason: "recipe" }))),
      onPick: () => again(),
    });
    name.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      App.ingSuggest.takeActive(name);
      again();
      // the empty line at the end -- a pot that came back keeps its lines untouched
      const blank = this._body.querySelector(".bk-rows .bk-row:last-child .bk-ing");
      if (blank) blank.focus();
    });
    box.querySelector(".bk-yield").addEventListener("input", () => this._preview());
    box.querySelector(".bk-yield").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._make(); } });
    box.querySelector(".bk-date").addEventListener("change", () => this._saveDraft());
    box.querySelectorAll(".bk-where .icon-btn").forEach(b => b.addEventListener("click", () => { this._where = b.dataset.where; this._paintWhere(); this._saveDraft(); }));
    box.querySelector(".bk-go").addEventListener("click", () => this._make());
    this._paintWhere();
    this._preview();
  },

  _paintWhere() {
    const box = this._body.querySelector(".bk-make");
    box.querySelectorAll(".bk-where .icon-btn").forEach(b => b.classList.toggle("on", b.dataset.where === this._where));
    box.querySelector(".bk-go").title = `Make it — into the ${this._where === "pantry" ? "dry pantry" : this._where}, its ingredients out of the kitchen`;
  },

  _row(item) {
    const ing = item && item.ingredient_id ? this._ingredients.find(i => i.id === item.ingredient_id) : null;
    const row = App.el(`<div class="mb-row bk-row">
      <input class="mb-ing bk-ing" placeholder="＋ add an ingredient" spellcheck="false" autocomplete="off" enterkeyhint="enter" value="${App.esc(item ? (item.name || (ing ? ing.name : "")) : "")}">
      <input class="mb-amt bk-amt num" placeholder="amt" spellcheck="false" enterkeyhint="enter" value="${item ? App.esc(_mbFormatAmount(item.qty, item.unit)) : ""}">
      <span class="mb-stat num"></span>
      <button class="icon-btn mb-row-x" title="Remove line" tabindex="-1">${App.icon(GP_X)}</button>
    </div>`);
    const remove = () => { row.remove(); this._ensureBlank(); this._preview(); };
    row.querySelector(".mb-row-x").addEventListener("click", remove);
    App.swipeAway(row, remove, { wrap: false, can: () => row.querySelector(".bk-ing").value.trim() !== "" });
    row.querySelectorAll("input").forEach(i => i.addEventListener("input", () => this._preview()));
    // a name not in the catalog yet becomes an ingredient as soon as it's written, like a meal
    // line's, so its stats show here once its USDA match lands -- not only after ✓
    row.querySelector(".bk-ing").addEventListener("change", async (e) => {
      const name = e.target.value.trim();
      if (!name || this._ingredients.some(i => i.name.toLowerCase() === name.toLowerCase())) return;
      try {
        await App.resolveIngredientId(name, "g", this._ingredients, true);
        this._preview();
        App._resolveQueue.then(() => this._preview());
      } catch (err) { /* made on ✓ instead */ }
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); e.target.blur(); return; }
      if (e.key !== "Enter" && e.key !== "Tab") return;
      if (e.shiftKey) return;
      const onName = e.target.classList.contains("bk-ing");
      if (onName) { const pick = App.ingSuggest.active(); if (pick) App.ingSuggest.accept(pick); App.ingSuggest.close(); }
      const blank = !row.querySelector(".bk-ing").value.trim() && !row.querySelector(".bk-amt").value.trim();
      e.preventDefault();
      if (blank) { this._body.querySelector(".bk-yield").focus(); return; }
      if (onName) { row.querySelector(".bk-amt").select(); row.querySelector(".bk-amt").focus(); return; }
      let next = row.nextElementSibling;
      if (!next) { next = this._row(null); row.after(next); }
      next.querySelector(".bk-ing").focus();
    });
    App.ingSuggest.attach(row.querySelector(".bk-ing"), {
      context: () => ({
        meal_name: this._body.querySelector(".bk-name").value.trim(),
        used: this._readRows().map(r => r.ingredient_id).filter(Boolean),
      }),
      onPick: (it) => { row.querySelector(".bk-amt").placeholder = it.typical ? it.typical.label : "amt"; },
    });
    return row;
  },

  // exactly one empty line, at the end (the focused one may be the empty one)
  _ensureBlank() {
    const wrap = this._body && this._body.querySelector(".bk-rows");
    if (!wrap) return;
    const blank = (r) => !r.querySelector(".bk-ing").value.trim() && !r.querySelector(".bk-amt").value.trim();
    const rows = Array.from(wrap.children);
    const focused = rows.find(r => r.contains(document.activeElement));
    const last = rows[rows.length - 1];
    const keep = focused && blank(focused) ? focused : (last && blank(last) ? last : null);
    rows.forEach(r => { if (r !== keep && blank(r)) r.remove(); });
    if (!keep) wrap.appendChild(this._row(null));
  },

  _readRows() {
    return Array.from(this._body.querySelectorAll(".bk-row")).map(el => {
      const name = el.querySelector(".bk-ing").value.trim();
      const amt = _mbParseAmount(el.querySelector(".bk-amt").value) || { qty: 0, unit: "" };
      const ing = this._ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
      return { el, name, qty: amt.qty, unit: _mbUnit(amt, ing), ingredient_id: ing ? ing.id : null };
    }).filter(r => r.name);
  },

  _saveDraft() {
    const box = this._body && this._body.querySelector(".bk-make");
    if (!box) return;
    this._draft = {
      name: box.querySelector(".bk-name").value, yield_text: box.querySelector(".bk-yield").value,
      date: box.querySelector(".bk-date").value || _bkToday(), where: this._where,
      lines: this._readRows().map(({ name, qty, unit, ingredient_id }) => ({ name, qty, unit, ingredient_id })),
    };
  },

  // the stats beside each line, and what the whole pot comes to per unit
  _preview() {
    this._saveDraft();
    clearTimeout(this._pt);
    this._pt = setTimeout(async () => {
      const seq = this._pseq = (this._pseq || 0) + 1;      // only the newest answer is drawn
      const rows = this._readRows();
      const known = rows.filter(r => r.ingredient_id);
      const sum = this._body.querySelector(".bk-sum");
      if (!sum) return;
      let res;
      try {
        res = await App.api("/api/bulk/preview", { method: "POST", body: {
          rows: known.map(r => ({ ingredient_id: r.ingredient_id, qty: r.qty, unit: r.unit })),
          yield_text: this._body.querySelector(".bk-yield").value } });
      } catch (e) { return; }
      if (seq !== this._pseq) return;
      rows.forEach(r => { r.el.querySelector(".mb-stat").textContent = ""; });
      known.forEach((r, i) => { r.el.querySelector(".mb-stat").textContent = _mbStat(res.rows[i], false); });
      if (!known.length) { sum.innerHTML = ""; return; }
      const t = res.total;
      const pu = res.per_unit;
      sum.innerHTML = `<span title="Everything that goes in">${App.esc(res.input_text || "—")} in · ${Math.round(t.calories_kcal)} kcal · ${t.protein_g.toFixed(0)} g P</span>`
        + (res.yield_g && res.yield_g !== res.input_g ? ` <span title="What it makes">→ ${App.esc(res.yield_text_g)}</span>` : "")
        + (pu ? ` <b class="bk-per">1 ${App.esc(pu.word)} · ${Math.round(pu.calories_kcal)} kcal · ${pu.protein_g.toFixed(1)} g P</b>`
              : res.per100 ? ` <b class="bk-per">100 g · ${Math.round(res.per100.calories_kcal)} kcal · ${res.per100.protein_g.toFixed(1)} g P</b>` : "")
        + (res.per_cup && (!pu || pu.word !== "cup") ? ` <span title="What 1 cup of it in a meal counts">· 1 cup ${Math.round(res.per_cup.calories_kcal)} kcal</span>` : "")
        + (!res.per_cup ? ` <span class="bk-hint" title="A meal line can then say &quot;1 cup&quot; of it">· add cups to use it by the cup — "8 cups, 3 lb"</span>` : "");
    }, 220);
  },

  async _make() {
    const box = this._body.querySelector(".bk-make");
    const name = box.querySelector(".bk-name").value.trim();
    const rows = this._readRows();
    if (!name) { App.toast("What's being made?"); box.querySelector(".bk-name").focus(); return; }
    if (!rows.length) { App.toast("What goes in?"); box.querySelector(".bk-ing").focus(); return; }
    // a line with no amount would go in as 0 and take its nutrition with it (Storm 2026-10-26:
    // "why does it say the gruyere cheese is 0")
    const bare = rows.find(r => !(r.qty > 0));
    if (bare) { App.toast(`How much ${bare.name}?`); bare.el.querySelector(".bk-amt").focus(); return; }
    const go = box.querySelector(".bk-go");
    go.disabled = true;
    try {
      const lines = [];
      for (const r of rows) {
        const id = r.ingredient_id || await App.resolveIngredientId(r.name, r.unit, this._ingredients, true);
        lines.push({ ingredient_id: id, qty: r.qty, unit: r.unit });
      }
      const res = await App.api("/api/bulk", { method: "POST", body: {
        name, rows: lines, yield_text: box.querySelector(".bk-yield").value, where: this._where,
        date: box.querySelector(".bk-date").value || _bkToday() } });
      this._data = res;
      const it = res.items.find(i => i.ingredient_id === res.made.ingredient_id);
      const said = it && it.have[this._where] ? it.have[this._where].text : (res.made.yield_text || "");
      App.toast(`${name} → ${this._where === "pantry" ? "dry pantry" : this._where}${said ? " · " + said : ""}`);
      this._draft = null;
      const ings = await App.api("/api/ingredients");
      this._ingredients = ings.ingredients;
      this._drawMake(null);
      this._drawItems();
      // a new ingredient's USDA match lands a moment later: then its nutrition counts
      App._resolveQueue.then(() => App.api("/api/bulk")).then((d) => {
        if (App.state.view !== "bulk" || !document.body.contains(this._body.querySelector(".bk-items"))) return;
        this._data = d;
        this._drawItems();
      }).catch(() => {});
    } catch (e) {
      App.toast(e.message);
    } finally {
      go.disabled = false;
    }
  },

  // ↻: the pot it last came from, back on the left to make again
  _again(it) {
    const l = it.last;
    this._drawMake({ name: it.name, yield_text: l.yield_text || "", where: l.where, date: _bkToday(),
                     lines: l.lines.map(x => ({ ...x })) });
    this._body.querySelector(".bk-make").scrollIntoView({ block: "nearest" });
  },

  // a name's lines in place of the ones there, without redrawing the name box being typed in;
  // a bulk pot also brings back what it made and where it went
  _fillRows(lines, yieldText, where) {
    const box = this._body.querySelector(".bk-make");
    const rows = box.querySelector(".bk-rows");
    rows.innerHTML = "";
    lines.forEach(l => rows.appendChild(this._row({ ingredient_id: l.ingredient_id, qty: l.qty, unit: l.unit })));
    this._ensureBlank();
    if (yieldText !== undefined) box.querySelector(".bk-yield").value = yieldText;
    if (where) { this._where = where; this._paintWhere(); }
    this._preview();
    this._saveDraft();
  },

  // ── everything made in bulk ────────────────────────────────────────
  _drawItems() {
    const wrap = this._body.querySelector(".bk-items");
    const items = this._data.items;
    wrap.innerHTML = items.length ? "" : `<div class="gp-empty">Nothing made in bulk yet. What's made here goes straight into the kitchen and shows up as an ingredient in meals — "1 cup black beans" counts everything that went into the pot.</div>`;
    items.forEach(it => {
      const have = Object.entries(it.have).map(([w, h]) =>
        `<span class="bk-have where-${w}" title="${w === "pantry" ? "Dry pantry" : w[0].toUpperCase() + w.slice(1)}">${App.icon(GP_PLACES[w][0])}${App.esc(h.text)}</span>`).join("");
      const pu = it.per_unit, p = it.per100;
      const stat = pu ? `1 ${App.esc(pu.word)} · ${Math.round(pu.calories_kcal)} kcal · ${pu.protein_g.toFixed(1)} g P`
        : p ? `100 g · ${Math.round(p.calories_kcal)} kcal · ${p.protein_g.toFixed(1)} g P` : "nutrition unknown";
      const lines = it.last.lines.map(l => `${App.esc(l.name)} ${App.esc(_mbFormatAmount(l.qty, l.unit))}`).join(" · ");
      const el = App.el(`<div class="bk-item${Object.keys(it.have).length ? "" : " gone"}">
        <div class="bk-item-top">
          <span class="bk-item-name">${App.esc(it.name)}</span>
          ${have || `<span class="dim bk-have">none left</span>`}
          <button class="icon-btn bk-again" title="Make it again">${App.icon(BK_AGAIN)}</button>
        </div>
        <div class="bk-item-stat num" title="${it.unknown.length ? "Not counted (no nutrition known): " + App.esc(it.unknown.join(", ")) : "Everything that went in, spread over what it made"}">${stat}${it.unknown.length ? ` <span class="warn">+${it.unknown.length}?</span>` : ""}</div>
        <div class="bk-item-lines dim" title="Last made ${_gpDay(it.last.date)}${it.last.yield_text ? " — made " + App.esc(it.last.yield_text) : ""}">${lines}</div>
      </div>`);
      el.querySelector(".bk-again").addEventListener("click", () => this._again(it));
      wrap.appendChild(el);
    });
    const log = this._body.querySelector(".bk-log");
    const makes = this._data.makes;
    log.innerHTML = makes.length ? `<div class="field-label">Made</div>` : "";
    makes.forEach(m => {
      const el = App.el(`<div class="bk-made${m.undone ? " undone" : ""}">
        <span class="gp-place where-${m.where}">${App.icon(GP_PLACES[m.where][0])}</span>
        <span class="bk-made-day num dim">${_gpDay(m.date)}</span>
        <span class="bk-made-name">${App.esc(m.name)}</span>
        <span class="dim num">${App.esc(m.yield_text || "")}</span>
        <button class="icon-btn bk-undo" title="${m.undone ? "Put it back" : "Undo — take it back out of the kitchen"}">${App.icon(m.undone ? BK_AGAIN : BK_UNDO)}</button>
      </div>`);
      el.querySelector(".bk-undo").addEventListener("click", async () => {
        this._data = await App.api(`/api/bulk/${m.id}/undo`, { method: "POST", body: { undone: !m.undone } });
        App.toast(m.undone ? `${m.name}: back in` : `${m.name}: undone`);
        this._drawItems();
      });
      log.appendChild(el);
    });
  },
};

function _bkToday() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
