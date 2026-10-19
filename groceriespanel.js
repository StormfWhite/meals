/* The shopping list that sits beside the plan: what the week's meals need
 * at the store on top, what they need at the farmer's market underneath.
 * Docked on the right every day, always for the week you're shopping FOR
 * (plan.js decides which that is and passes the label).
 *
 * The two sections are one list split by destination, not two kinds of
 * thing. Every ingredient written into any meal lands in one of them
 * automatically — vegetables at the market, garlic and frozen peas at the
 * store (aisles.py owns that rule) — so the plan and the lists can't
 * drift apart. The ⇄ on a row moves an item to the other list for good.
 *
 * Each section is headed by the real shop it's for, picked by name from
 * what's actually near you (storepicker.js), and totals itself from
 * remembered or live prices. A row with no price shows a dash and is
 * counted separately: a total that quietly skipped items would read as
 * though it were complete.
 *
 * The farmer's-market section also keeps the freeform lines ("3 eggplant")
 * — typed straight in, never parsed, still the fastest way to note
 * something you'll just grab.
 *
 * A name is a whole entry; the amount beside it is optional and kept
 * exactly as typed ("2 lb", "a dozen") — never turned into grams.
 *
 * The usuals: what's been added by hand week after week comes back as a
 * dimmed row under each section (groceries.suggestions). Tap it and it's on
 * the list; ✕ it and it's gone for the week, and counts against coming
 * back. On a phone they wait behind the ▾ at the end of the add bar, so
 * tapping the bar to type is just typing. Rows swipe away on a phone.
 */
window.App = window.App || {};

const GP_CART = '<path d="M6 6h15l-2 9H8L5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>';
const GP_BASKET = '<path d="M3 9h18l-1.5 11H4.5Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>';
const GP_SWAP = '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>';
const GP_COPY = '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const GP_X = '<path d="M18 6 6 18M6 6l12 12"/>';
const GP_MEAL = '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>';
const GP_PLUS = '<path d="M12 5v14M5 12h14"/>';
const GP_DOWN = '<path d="m6 9 6 6 6-6"/>';
const GP_AISLE = '<path d="M4 3v18M20 3v18"/><path d="M4 8h5M4 14h5M15 8h5M15 14h5"/>';
const GP_SNOW = '<path d="M12 2v20M4.9 7l14.2 10M4.9 17 19.1 7"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>';
const GP_PANTRY = '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 10h16M10 6.5h4M10 14h4"/>';
const GP_WARN = '<path d="M12 3 2 20h20Z"/><path d="M12 10v4M12 17h.01"/>';
const GP_USUAL = '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>';
const gpPhone = () => window.matchMedia("(max-width: 760px)").matches;

App.groceriesPanel = {
  _container: null,
  _weekStart: null,    // the grocery list's week
  _marketWeek: null,   // the farmer's market list's week: it resets on its own (groceries.list_week)
  _onCount: null,
  _timer: null,
  _title: "",
  _range: "",
  _shops: { grocery: null, market: null },
  _sugOpen: { grocery: false, market: false },   // phone only: the ▾ in the add bar
  _addQueue: Promise.resolve(),
  _pending: [],        // typed but still being looked up (USDA, ~3 s each): shown at once, faintly

  mount(container, weekStart, onCount, title, range, marketWeek) {
    this._container = container;
    this._weekStart = weekStart;
    this._marketWeek = marketWeek || weekStart;
    this._onCount = onCount || null;
    this._title = title || "This week";
    this._range = range || "";
    container.innerHTML = "";   // a new mount draws its own frame (title, week)
    this.refresh();
  },

  // Called on every plan edit (a new meal changes what's needed), so it's
  // debounced and it restores whatever field was focused -- a redraw
  // triggered by a commit two columns away must not eat what's being typed
  // into the list.
  refresh() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._reload().catch(() => {}), 300);
  },

  async _reload() {
    if (!this._container || !this._container.isConnected) return;
    const gw = this._weekStart, mw = this._marketWeek, two = mw !== gw;
    const [gRes, ingredientsRes, freeRes, gSug, mRes, mSug] = await Promise.all([
      App.api(`/api/groceries/${gw}`),
      App.api("/api/ingredients"),
      App.api(`/api/groceries/${mw}/free-list`),
      App.api(`/api/groceries/${gw}/suggestions`).catch(() => ({ items: [] })),
      two ? App.api(`/api/groceries/${mw}`) : null,
      two ? App.api(`/api/groceries/${mw}/suggestions`).catch(() => ({ items: [] })) : null,
    ]);
    // each section from its own week: groceries from the grocery week, the market from the market's
    const mItems = (mRes || gRes).items, mSugs = (mSug || gSug).items;
    const itemsRes = {
      items: gRes.items.filter(i => i.shop_list !== "market").concat(mItems.filter(i => i.shop_list === "market")),
      totals: { grocery: gRes.totals.grocery, market: (mRes || gRes).totals.market },
      store: gRes.store, market: gRes.market,
    };
    const sugRes = { items: gSug.items.filter(x => x.shop_list !== "market").concat(mSugs.filter(x => x.shop_list === "market")) };
    this._shops = { grocery: itemsRes.store, market: itemsRes.market };
    const focus = _gpCaptureFocus(this._container);
    this._draw(itemsRes.items, ingredientsRes.ingredients, freeRes.items, itemsRes.totals, sugRes.items);
    this._priceMissing(itemsRes.items);
    _gpRestoreFocus(this._container, focus);
    if (this._onCount) {
      this._onCount(itemsRes.items.filter(i => !i.checked).length + freeRes.items.filter(i => !i.checked).length);
    }
  },

  _draw(items, ingredients, freeItems, totals, sugs) {
    const container = this._container;
    const grocery = items.filter(i => i.shop_list !== "market");
    const market = items.filter(i => i.shop_list === "market");
    sugs = sugs || [];
    const sugFor = (kind) => sugs.filter(s => (s.shop_list === "market" ? "market" : "grocery") === kind);
    this._ingredients = ingredients;
    // The frame (and its add bars) is built once per mount and only the parts inside it refresh:
    // replacing the field being typed in drops a phone's keyboard after every Enter, so the next
    // item couldn't just be typed.
    if (!container.querySelector(".gp-head")) this._frame();

    container.querySelector('[data-list="grocery"] .gp-head-slot').innerHTML =
      this._sectionHead("grocery", GP_CART, "Groceries", grocery, totals);
    container.querySelector('[data-list="market"] .gp-head-slot').innerHTML =
      this._sectionHead("market", GP_BASKET, "Farmer's market", market, totals);
    container.querySelectorAll(".gp-stock-badges").forEach(b => b.addEventListener("click", () => this._toggleStock()));
    // the meal lines whose ingredient comes out of what's on hand get marked (mealblock.js)
    const onHand = new Set(items.filter(i => i.covered).map(i => i.name.toLowerCase()));
    document.querySelectorAll(".mb-row").forEach(r => {
      const on = onHand.has((r.querySelector(".mb-ing") || {}).value?.trim().toLowerCase());
      r.classList.toggle("on-hand", on);
      if (on) r.title = "Taken from what's on hand — nothing to buy";
    });
    if (this._stockOpen) this._loadStock();
    const datalist = container.querySelector("#gp-ingredient-catalog");
    if (datalist) datalist.innerHTML = ingredients.map(i => `<option value="${App.esc(i.name)}">`).join("");

    const rowsOf = (id) => { const el = container.querySelector(id); el.innerHTML = ""; return el; };
    const groceryRows = rowsOf("#gp-grocery-rows");
    this._fill(groceryRows, grocery, this._pending.length ? "" : "Nothing needed yet — plan some meals.");
    this._pending.forEach(p => groceryRows.appendChild(App.el(`<div class="gp-row gp-pending">
      <span class="gp-row-name">${App.esc(p.name)}</span><span class="gp-row-need dim num">${App.esc(p.qty)}</span></div>`)));
    this._fill(rowsOf("#gp-market-rows"), market, "Nothing fresh needed yet.");
    const freeRows = rowsOf("#gp-free-rows");
    freeItems.forEach(item => freeRows.appendChild(App.swipeAway(this._freeRow(item), async () => {
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "DELETE" });
      this._reload();
    })));
    ["grocery", "market"].forEach(kind => {
      const wrap = rowsOf(`#gp-${kind}-sugs`);
      const mine = sugFor(kind);
      mine.forEach(s => wrap.appendChild(this._sugRow(s)));
      const btn = container.querySelector(`.gp-sug-toggle[data-list="${kind}"]`);
      btn.hidden = !mine.length;
      btn.title = `${mine.length} usual${mine.length > 1 ? "s" : ""}`;
      btn.querySelector(".gp-sug-n").textContent = mine.length;
    });

    this._wireStoreHeads();
    this._wireCopy();
  },

  _frame() {
    const container = this._container;
    // a phone's datalist pops the whole catalog the moment the bar is tapped
    const listAttr = gpPhone() ? "" : 'list="gp-ingredient-catalog"';
    const sugToggle = (kind) => `<button class="icon-btn gp-sug-toggle" data-list="${kind}" hidden>${App.icon(GP_DOWN)}<span class="gp-sug-n num"></span></button>`;
    const open = (kind) => this._sugOpen[kind] ? " sug-open" : "";
    // enterkeyhint "enter", not "done": done asks the keyboard to go away; Enter here means "next item"
    container.innerHTML = `
      <div class="gp-head">
        <span class="gp-head-title">${App.esc(this._title)}</span>
        <span class="gp-head-range dim num">${App.esc(this._range)}</span>
      </div>
      <div class="gp-section${open("grocery")}" data-list="grocery">
        <div class="gp-head-slot"></div>
        <div class="gp-rows" id="gp-grocery-rows"></div>
        <div class="gp-add-row">
          <input class="gp-add-name" ${listAttr} placeholder="Add an item…" spellcheck="false" enterkeyhint="enter">
          <input class="gp-add-qty" placeholder="qty" spellcheck="false" enterkeyhint="enter">
          ${sugToggle("grocery")}
        </div>
        <div class="gp-rows gp-sugs" id="gp-grocery-sugs"></div>
        ${listAttr ? '<datalist id="gp-ingredient-catalog"></datalist>' : ""}
      </div>
      <div class="gp-section gp-market${open("market")}" data-list="market">
        <div class="gp-head-slot"></div>
        <div class="gp-rows" id="gp-market-rows"></div>
        <div class="gp-rows gp-free" id="gp-free-rows"></div>
        <div class="gp-add-row">
          <input class="gp-free-add" placeholder="Add a line, press Enter…" spellcheck="false" enterkeyhint="enter">
          ${sugToggle("market")}
        </div>
        <div class="gp-rows gp-sugs" id="gp-market-sugs"></div>
      </div>
      <div class="gp-section gp-stock" hidden>
        <div class="gp-section-head">
          <span class="field-label">${App.icon(GP_PANTRY)} On hand</span>
          <button class="icon-btn gp-stock-close" title="Close">${App.icon(GP_X)}</button>
        </div>
        <div class="gp-rows" id="gp-stock-rows"></div>
      </div>
    `;
    container.querySelector(".gp-stock-close").addEventListener("click", () => this._toggleStock(false));
    container.querySelectorAll(".gp-sug-toggle").forEach(btn => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.list;
        this._sugOpen[kind] = !this._sugOpen[kind];
        btn.closest(".gp-section").classList.toggle("sug-open", this._sugOpen[kind]);
      });
    });
    this._wireAdd();
    this._wireFree();
  },

  _wk(kind) { return kind === "market" ? this._marketWeek : this._weekStart; },

  /* Unpriced rows at a store with live prices (Ralphs and the other Kroger banners) are looked
   * up by themselves, in the background -- each at most once a day, so an item the store doesn't
   * carry isn't asked about on every redraw. The list redraws when any price came back. */
  _priceMissing(items) {
    if (this._pricing) return;
    let tried = {};
    try { tried = JSON.parse(localStorage.getItem("meals.priced") || "{}"); } catch (e) {}
    const day = new Date().toDateString();
    const todo = items.filter(i => (i.price == null || i.aisle_known === false) && (this._shops[i.shop_list] || {}).chain === "kroger"
                                   && tried[i.ingredient_id] !== day);
    if (!todo.length) return;
    const batch = todo.slice(0, 6);
    batch.forEach(i => { tried[i.ingredient_id] = day; });
    try { localStorage.setItem("meals.priced", JSON.stringify(tried)); } catch (e) {}
    this._pricing = true;
    const byWeek = {};
    batch.forEach(i => (byWeek[this._wk(i.shop_list)] = byWeek[this._wk(i.shop_list)] || []).push(i.ingredient_id));
    Promise.all(Object.entries(byWeek).map(([w, ids]) =>
      App.api(`/api/groceries/${w}/prices/lookup`, { method: "POST", body: { ids } }).catch(() => ({ found: 0 }))))
      .then(rs => { this._pricing = false; if (rs.some(r => r.found)) this.refresh(); })
      .catch(() => { this._pricing = false; });
  },

  _sectionHead(kind, icon, label, rows, totals) {
    const shop = this._shops[kind];
    const total = (totals && totals[kind]) || {};
    const money = total.estimated !== null && total.estimated !== undefined
      ? `$${total.estimated.toFixed(2)}` : "";
    // just the price (Storm 2026-10-18); what it leaves out is said on hover, not hidden
    const tip = total.unpriced ? `Not counted: ${total.unpriced} item${total.unpriced > 1 ? "s" : ""} with no price yet` : "Estimated, at this store";
    return `
      <div class="gp-section-head">
        <span class="field-label">${App.icon(icon)} ${label}</span>
        ${kind === "market" && this._marketWeek !== this._weekStart ? `<span class="gp-head-range dim num" title="The market list moved on by itself after the market trip">${App.esc(_gpRange(this._marketWeek))}</span>` : ""}
        ${total.to_freezer || total.wasted ? `<button class="gp-stock-badges num" title="${[total.to_freezer ? `${total.to_freezer} with extra for the freezer` : "", total.wasted ? `${total.wasted} likely to go bad before it's used` : ""].filter(Boolean).join(" · ")} — tap for what's on hand">${total.to_freezer ? `${App.icon(GP_SNOW)}${total.to_freezer}` : ""}${total.wasted ? `<span class="warn">${App.icon(GP_WARN)}${total.wasted}</span>` : ""}</button>` : ""}
        <span class="gp-total num" title="${tip}">${money}</span>
        <button class="icon-btn gp-copy" data-list="${kind}" title="Copy list">${App.icon(GP_COPY)}</button>
      </div>
      <button class="gp-store" data-kind="${kind}" title="Pick the shop this list is for">
        ${shop ? App.esc(shop.name) : "Pick a store"}
        ${shop && shop.chain === "kroger" ? '<span class="sp-live">live</span>' : ""}
      </button>
    `;
  },

  _fill(wrap, rows, emptyText) {
    if (!rows.length) {
      if (!emptyText) return;
      wrap.appendChild(App.el(`<div class="gp-empty">${App.esc(emptyText)}</div>`));
      return;
    }
    // At a store that says where things are (Ralphs does), grouped by aisle in walking order --
    // departments like Produce first, then Aisle 1, 2…; what it doesn't carry last.
    // Otherwise grouped by the meal that needs it, in the order next week cooks them; an item more
    // than one meal needs sits under the first (its tooltip names the rest). What was added by hand
    // follows under "Added" -- headed only when there are meal groups above it.
    const onHand = rows.filter(r => r.covered);
    rows = rows.filter(r => !r.covered);
    const groups = new Map();
    const byAisle = rows.some(r => r.aisle);
    // departments (Produce, Fruit, Deli -- Kroger numbers them 0 or 105) before the numbered aisles
    const aisleKey = r => !r.aisle ? [1e9, 0] : /^aisle\b/i.test(r.aisle) ? [r.aisle_num ?? 999, r.aisle_bay ?? 0] : [-1, 0];
    [...rows].sort(byAisle
        ? (a, b) => { const x = aisleKey(a), y = aisleKey(b);
                      return x[0] - y[0] || (x[0] === -1 ? a.aisle.localeCompare(b.aisle) : 0) || x[1] - y[1]; }
        : (a, b) => (a.meal_order ?? 1e9) - (b.meal_order ?? 1e9))
      .forEach(item => {
        const key = byAisle ? (item.aisle || "Other") : (item.meals && item.meals.length ? item.meals[0] : "");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
    const headed = [...groups.keys()].some(k => k);
    groups.forEach((items, meal) => {
      if (headed) wrap.appendChild(App.el(`<div class="gp-group">${App.icon(byAisle ? GP_AISLE : meal ? GP_MEAL : GP_PLUS)}<span>${App.esc(meal || "Added")}</span></div>`));
      items.forEach(item => {
        const row = this._structuredRow(item);
        if (item.meals && (item.meals.length > 1 || byAisle && item.meals.length)) row.querySelector(".gp-row-name").title = "For " + item.meals.join(", ");
        wrap.appendChild(App.swipeAway(row, async () => {
          await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}`, { method: "DELETE" });
          App.toast(`${item.name} off the list`);
          this._reload();
        }));
      });
    });
    // what the meals take from the pantry or freezer: nothing to buy, said where it comes from
    if (onHand.length) {
      wrap.appendChild(App.el(`<div class="gp-group">${App.icon(GP_PANTRY)}<span>On hand</span></div>`));
      onHand.forEach(item => {
        const till = item.runs_out ? ` · lasts till ~${_gpDay(item.runs_out)}` : "";
        const row = App.el(`<div class="gp-row gp-onhand" title="Tap for what's on hand">
          <span class="gp-onhand-icon">${App.icon(item.freezes && item.keep_days < 14 ? GP_SNOW : GP_PANTRY)}</span>
          <span class="gp-row-name">${App.esc(item.name)}</span>
          <span class="gp-row-need dim num">${App.esc(item.need_text || "")}${till}</span>
        </div>`);
        row.addEventListener("click", () => this._toggleStock(true));
        wrap.appendChild(row);
      });
    }
  },

  // ── On hand: the pantry/fridge and the freezer (stock.py) ──────────────
  _toggleStock(open) {
    this._stockOpen = open === undefined ? !this._stockOpen : open;
    const sec = this._container.querySelector(".gp-stock");
    sec.hidden = !this._stockOpen;
    if (this._stockOpen) { this._loadStock(); sec.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  },

  async _loadStock() {
    const res = await App.api(`/api/stock/${this._weekStart}`);
    const wrap = this._container.querySelector("#gp-stock-rows");
    wrap.innerHTML = "";
    if (!res.items.length) {
      wrap.appendChild(App.el(`<div class="gp-empty">Nothing yet — what's bought beyond the week's meals shows up here.</div>`));
      return;
    }
    const put = async (item, body) => {
      await App.api(`/api/stock/${this._weekStart}/${item.ingredient_id}`, { method: "PUT", body });
      this._reload();
    };
    res.items.forEach(item => {
      const row = App.el(`<div class="gp-row gp-stock-row">
        <span class="gp-row-name">${App.esc(item.name)}</span>
        <span class="gp-stock-where" title="Fridge / pantry">${App.icon(GP_PANTRY)}<input class="gp-row-qty num" data-frozen="false" value="${App.esc(item.fridge_text)}" placeholder="—" enterkeyhint="done"></span>
        <span class="gp-stock-where" title="Freezer">${App.icon(GP_SNOW)}<input class="gp-row-qty num" data-frozen="true" value="${App.esc(item.freezer_text)}" placeholder="—" enterkeyhint="done"></span>
        <span class="gp-row-need dim num" title="When it has to be bought again">${item.runs_out ? "~" + _gpDay(item.runs_out) : ""}</span>
      </div>`);
      row.querySelectorAll("input").forEach(inp => {
        const was = inp.value;
        inp.addEventListener("change", () => { if (inp.value !== was) put(item, { text: inp.value || "0", frozen: inp.dataset.frozen === "true" }); });
        inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.blur(); });
      });
      wrap.appendChild(App.swipeAway(row, async () => {
        App.toast(`${item.name}: used up`);
        await put(item, { grams: 0 });
      }));
    });
  },

  // The leftover math under a row (stock.py): need · on hand · packages · where the extra goes.
  _mathLine(item) {
    const parts = [];
    // which product that is at the store -- the brand, said once (Storm: "show the brand somewhere")
    const product = item.product ? `<div class="gp-product" title="${App.esc(item.price_label || "")}">${App.esc(item.product)}</div>` : "";
    const pkgs = item.packages && item.package_g ? `${item.packages} × ${_gpUs(item.package_g)}` : "";
    if (item.on_hand_g > 0.5) parts.push(`need ${item.need_text} · ${_gpUs(item.on_hand_g)} on hand`);
    else if (pkgs && item.need_text) parts.push(`need ${item.need_text}`);
    if (pkgs) parts.push(pkgs);
    // meat left after the week is frozen and THEN eaten next week: one fact, said once
    const nxt = item.next_week_g > 0.5 ? item.next_week_g : 0;
    const frozenForNext = item.frozen_g > 0.5 ? Math.min(nxt, item.frozen_g) : 0;
    if (nxt) parts.push(frozenForNext ? `${App.icon(GP_SNOW)} ${_gpUs(nxt)} for next week` : `${_gpUs(nxt)} next week`);
    if (item.frozen_g - frozenForNext > 0.5) parts.push(`${App.icon(GP_SNOW)} ${_gpUs(item.frozen_g - frozenForNext)}`);
    if (item.wasted_g > 0.5) parts.push(`<span class="warn" title="Won't keep till it's next used — plan a meal with it, or buy less">${App.icon(GP_WARN)} ${_gpUs(item.wasted_g)} may go bad</span>`);
    else if (item.left_g - nxt - (item.frozen_g - frozenForNext || 0) > 0.5 && item.need_g) {
      const rest = item.left_g - nxt - Math.max(0, item.frozen_g - frozenForNext);
      parts.push(item.runs_out ? `lasts till ~${_gpDay(item.runs_out)}` : `${_gpUs(rest)} → pantry`);
    }
    const wk = this._wk(item.shop_list);
    let bulk = "";
    if (item.package) {
      bulk = `<button class="gp-bulk on" title="Back to the usual size">${App.esc(_gpUs(item.package.package_g))} pack ${App.icon(GP_X)}</button>`;
    } else if (item.bulk) {
      const b = item.bulk;
      bulk = `<button class="gp-bulk" title="${App.esc(b.label || "")}">${App.esc(_gpUs(b.package_g))} pack saves $${b.saves.toFixed(2)}${b.frozen_g > 0.5 ? ` · ${App.icon(GP_SNOW)} ${_gpUs(b.frozen_g)}` : ""}</button>`;
    }
    if (!parts.length && !bulk && !product) return null;
    const el = App.el(`<div class="gp-math num">${product}${parts.length ? `<span>${parts.join(" · ")}</span>` : ""}${bulk}</div>`);
    const btn = el.querySelector(".gp-bulk");
    if (btn) btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await App.api(`/api/groceries/${wk}/items/${item.ingredient_id}/package`, { method: "PUT", body: { package: item.package ? null : item.bulk } });
      this._reload();
    });
    return el;
  },

  // A usual: tap it to put it on the list, ✕ (or swipe) for not this week.
  _sugRow(sug) {
    const url = `/api/groceries/${this._wk(sug.shop_list)}/suggestions/${encodeURIComponent(sug.key)}`;
    const row = App.el(`<div class="gp-row gp-sug" title="On the list ${sug.weeks} of the last ${sug.of} weeks — tap to add">
      <span class="gp-sug-icon">${App.icon(GP_USUAL)}</span>
      <span class="gp-row-name">${App.esc(sug.name)}</span>
      <span class="gp-row-need dim num">${sug.weeks}/${sug.of}</span>
      <button class="icon-btn gp-sug-x" title="Not this week">${App.icon(GP_X)}</button>
    </div>`);
    const dismiss = async () => {
      await App.api(`${url}/dismiss`, { method: "POST" });
      this._reload();
    };
    row.addEventListener("click", async (e) => {
      if (e.target.closest(".gp-sug-x")) return;
      row.classList.add("taken");
      await App.api(`${url}/accept`, { method: "POST" });
      this._reload();
    });
    row.querySelector(".gp-sug-x").addEventListener("click", (e) => {
      e.stopPropagation();
      row.classList.add("taken");
      dismiss();
    });
    return App.swipeAway(row, dismiss);
  },

  _wireStoreHeads() {
    this._container.querySelectorAll(".gp-store").forEach(btn => {
      btn.addEventListener("click", () => {
        const kind = btn.dataset.kind;
        App.storePicker.open(btn, {
          kind,
          current: this._shops[kind],
          onPick: async (shop) => {
            const placesRes = await App.api("/api/places");
            const active = placesRes.active;
            if (!active) { App.toast("Set where you live first"); return; }
            await App.api(`/api/places/${active.id}`, {
              method: "PUT",
              body: kind === "market" ? { market: shop } : { store: shop },
            });
            App.toast(`${kind === "market" ? "Market" : "Store"}: ${shop.name}`);
            this._reload();
          },
        });
      });
    });
  },

  _structuredRow(item) {
    const other = item.shop_list === "market" ? "grocery" : "market";
    const price = item.price !== null && item.price !== undefined ? `$${item.price.toFixed(2)}` : "";
    const stale = item.price_age_days > 60 ? " stale" : "";
    const row = App.el(`<div class="gp-row ${item.checked ? "done" : ""}" data-ing="${App.esc(item.ingredient_id)}">
      <label class="check"><input type="checkbox" class="gp-chk" ${item.checked ? "checked" : ""}><span class="box">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span></label>
      <input class="gp-row-name" value="${App.esc(item.name)}" title="${App.esc(item.price_label || item.name)}" spellcheck="false" enterkeyhint="done">
      <input class="gp-row-qty num" placeholder="qty" value="${App.esc(item.unit_label)}" spellcheck="false" enterkeyhint="done" title="Amount — type it however you like">
      <input class="gp-row-price num${stale}" placeholder="$—" value="${price}"
             title="${item.price ? `${App.esc(item.price_label || "")}${item.price_age_days ? ` · ${item.price_age_days}d ago` : ""}${item.packages > 1 ? ` · ×${item.packages}` : ""}` : "What does one cost? Type it once."}">
      <button class="icon-btn gp-move" title="Move to the ${other === "market" ? "farmer's market" : "grocery"} list">${App.icon(GP_SWAP)}</button>
      ${item.source === "extra" ? `<button class="icon-btn gp-row-remove-extra" title="Remove the amount added by hand">${App.icon(GP_X)}</button>` : ""}
    </div>`);

    const math = this._mathLine(item);
    if (math) row.appendChild(math);
    if (item.sizes && item.sizes.length) _gpSizeList(row.querySelector(".gp-row-qty"), item.sizes);

    row.querySelector(".gp-chk").addEventListener("change", async (e) => {
      row.classList.toggle("done", e.target.checked);
      if (e.target.checked) window.MealsAndroid?.shopping?.();   // the phone starts watching for leaving the shop
      await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}`, { method: "PUT", body: { checked: e.target.checked } });
      this._reload();
    });

    // Tap the name to change it. A hand-added row becomes the new item (amount, tick, list kept);
    // a row the meals put there renames that ingredient everywhere -- the way to fix "chiken".
    const nameBox = row.querySelector(".gp-row-name");
    nameBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.keyCode === 13) nameBox.blur();
      if (e.key === "Escape") { nameBox.value = item.name; nameBox.blur(); }
    });
    nameBox.addEventListener("change", async () => {
      const name = nameBox.value.trim();
      if (!name || name === item.name) { nameBox.value = item.name; return; }
      const taken = this._ingredients.find(i => i.name.toLowerCase() === name.toLowerCase() && i.id !== item.ingredient_id);
      try {
        if (item.source === "extra") {
          const to = await App.resolveIngredientId(name, "g", this._ingredients, true);
          await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}/swap`, { method: "POST", body: { to } });
        } else if (taken) {
          App.toast(`${taken.name} is another item — change it in the meal`);
          nameBox.value = item.name;
          return;
        } else {
          await App.api(`/api/ingredients/${item.ingredient_id}`, { method: "PUT", body: { name } });
        }
      } catch (e) { App.toast(`Couldn't rename: ${e.message}`); }
      this._reload();
    });

    // The amount is typed straight onto the row, kept as typed.
    const qtyBox = row.querySelector(".gp-row-qty");
    qtyBox.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) qtyBox.blur(); });
    qtyBox.addEventListener("change", async () => {
      await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}/amount`, {
        method: "PUT", body: { qty: qtyBox.value },
      });
      this._reload();
    });

    // A price is typed once and remembered for that shop from then on.
    row.querySelector(".gp-row-price").addEventListener("change", async (e) => {
      const raw = e.target.value.replace(/[^0-9.]/g, "");
      if (!raw) {
        await App.api(`/api/groceries/prices/${item.ingredient_id}`, { method: "DELETE" });
      } else {
        await App.api(`/api/groceries/prices/${item.ingredient_id}`, {
          method: "POST", body: { price: Number(raw) },
        });
      }
      this._reload();
    });

    row.querySelector(".gp-move").addEventListener("click", async () => {
      await App.api(`/api/ingredients/${item.ingredient_id}/shop-list`, {
        method: "POST", body: { shop_list: other },
      });
      App.toast(`${item.name} → ${other === "market" ? "farmer's market" : "groceries"}`);
      this._reload();
    });

    const removeBtn = row.querySelector(".gp-row-remove-extra");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        await App.api(`/api/groceries/${this._wk(item.shop_list)}/extra/${item.ingredient_id}`, { method: "DELETE" });
        this._reload();
      });
    }
    return row;
  },

  _wireAdd() {
    const container = this._container;
    const nameInput = container.querySelector(".gp-add-name");
    const qtyInput = container.querySelector(".gp-add-qty");
    // Fast on purpose: the bar clears the moment Enter is hit so the next
    // item can be typed while this one saves; adds run one after another.
    const addItem = () => {
      let name = nameInput.value.trim();
      if (!name) return;
      let qty = qtyInput.value.trim();
      if (!qty) [name, qty] = _gpSplitAmount(name);   // "grapes 2 lb" / "2 lb grapes" typed in one go
      nameInput.value = ""; qtyInput.value = "";
      nameInput.focus();
      const pend = { name, qty };
      this._pending.push(pend);
      const rows = container.querySelector("#gp-grocery-rows");
      rows.querySelector(".gp-empty")?.remove();
      rows.appendChild(App.el(`<div class="gp-row gp-pending"><span class="gp-row-name">${App.esc(name)}</span><span class="gp-row-need dim num">${App.esc(qty)}</span></div>`));
      this._addQueue = this._addQueue.then(async () => {
        const ingredients = this._ingredients;
        let match = ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
        // Something not in the catalog yet is created (and matched to USDA)
        // rather than refused -- the list is allowed to teach the catalog.
        // Made at once, matched to USDA afterwards: the item is on the list the moment Enter is hit.
        if (!match) {
          const created = await App.api("/api/ingredients", { method: "POST", body: { name, default_unit: "g", resolve: false } });
          match = created.ingredient;
          ingredients.push(match);
          App.resolveLater(match.id, () => this.refresh());
        }
        await App.api(`/api/groceries/${this._weekStart}/extra`, { method: "POST", body: { ingredient_id: match.id, qty: qty || null, shop_list: "grocery" } });
      }).catch(() => App.toast(`Couldn't add ${name}`))
        .then(() => { this._pending = this._pending.filter(p => p !== pend); return this._reload(); })
        .catch(() => {});   // a failed redraw must never stall the adds queued behind it
    };
    const onEnter = (e) => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); addItem(); sizesFor = ""; } };
    nameInput.addEventListener("keydown", onEnter);
    qtyInput.addEventListener("keydown", onEnter);
    // something the store has been asked about before: its sizes are offered in the amount box
    let sizesFor = "";
    const offerSizes = async () => {
      const name = nameInput.value.trim().toLowerCase();
      const match = name && (this._ingredients || []).find(i => i.name.toLowerCase() === name);
      if (!match || sizesFor === match.id) return;
      sizesFor = match.id;
      const res = await App.api(`/api/groceries/${this._weekStart}/sizes/${match.id}`).catch(() => ({ sizes: [] }));
      if (qtyInput.nextElementSibling && qtyInput.nextElementSibling.tagName === "DATALIST") qtyInput.nextElementSibling.remove();
      qtyInput.removeAttribute("list");
      if (res.sizes.length && sizesFor === match.id) _gpSizeList(qtyInput, res.sizes);
    };
    qtyInput.addEventListener("focus", offerSizes);
    nameInput.addEventListener("change", offerSizes);
  },

  _wireCopy() {
    const container = this._container;
    container.querySelectorAll(".gp-copy").forEach(btn => {
      btn.addEventListener("click", async () => {
        const kind = btn.dataset.list;
        const rows = Array.from(container.querySelectorAll(`.gp-section[data-list="${kind}"] .gp-row:not(.gp-sug)`));
        const text = rows.map(r => {
          const n = r.querySelector(".gp-row-name");
          const name = n.value !== undefined ? n.value : n.textContent;
          const need = r.querySelector(".gp-row-qty");
          return `- ${need && need.value ? need.value + " " : ""}${name}`;
        }).join("\n") || "(nothing needed)";
        navigator.clipboard.writeText(text).then(() => App.toast("Copied"));
      });
    });
  },

  _wireFree() {
    const freeAdd = this._container.querySelector(".gp-free-add");
    freeAdd.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      if (!freeAdd.value.trim()) return;
      const [text, qty] = _gpSplitAmount(freeAdd.value.trim());   // "6 peaches" → peaches · 6, like the grocery box
      freeAdd.value = "";
      await App.api(`/api/groceries/${this._marketWeek}/free-list`, { method: "POST", body: { text, qty } });
      this._reload();
    });
  },

  _freeRow(item) {
    const row = App.el(`<div class="gp-row ${item.checked ? "done" : ""}">
      <label class="check"><input type="checkbox" class="gp-free-chk" ${item.checked ? "checked" : ""}><span class="box">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span></label>
      <input class="gp-row-name" value="${App.esc(item.text)}" spellcheck="false" enterkeyhint="done">
      <input class="gp-row-qty num" placeholder="qty" value="${App.esc(item.qty || "")}" spellcheck="false" enterkeyhint="done">
      <button class="icon-btn gp-free-remove" title="Remove">${App.icon(GP_X)}</button>
    </div>`);
    row.dataset.free = item.id;
    const textBox = row.querySelector(".gp-row-name");
    textBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.keyCode === 13) textBox.blur();
      if (e.key === "Escape") { textBox.value = item.text; textBox.blur(); }
    });
    textBox.addEventListener("change", async () => {
      const text = textBox.value.trim();
      if (!text) { textBox.value = item.text; return; }   // emptying isn't deleting: swipe or ✕ does that
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "PUT", body: { text } });
      this._reload();
    });
    const qtyBox = row.querySelector(".gp-row-qty");
    qtyBox.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) qtyBox.blur(); });
    qtyBox.addEventListener("change", async () => {
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "PUT", body: { qty: qtyBox.value } });
      this._reload();
    });
    row.querySelector(".gp-free-chk").addEventListener("change", async (e) => {
      row.classList.toggle("done", e.target.checked);
      if (e.target.checked) window.MealsAndroid?.shopping?.();   // the phone starts watching for leaving the shop
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "PUT", body: { checked: e.target.checked } });
      this._reload();
    });
    row.querySelector(".gp-free-remove").addEventListener("click", async () => {
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "DELETE" });
      this._reload();
    });
    return row;
  },
};

/* An amount typed into the name box, at either end: "grapes 2 lb" → ["grapes", "2 lb"],
 * "2 lb grapes" → same, "3 lemons" → ["lemons", "3"]. Kept as typed, never converted; a name
 * with no number at either end comes back whole. */
const GP_UNITS = "cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|g|grams?|kg|oz|ounces?|lbs?|pounds?|ml|l|liters?|cans?|jars?|bags?|boxe?s?|packs?|packages?|bunch(?:es)?|heads?|dozen|doz|cartons?|bottles?|loaf|loaves|gal(?:lons?)?|qt|quarts?|pints?";
function _gpRange(week) {   // "Oct 25 – Oct 31", via plan.js's own formatter
  return typeof _planRange === "function" ? _planRange(week, _planShift(week, 6)) : week;
}

function _gpSplitAmount(text) {
  const num = "\\d+(?:[./]\\d+)?(?:\\s+\\d+/\\d+)?";
  let m = text.match(new RegExp(`^(.+?)\\s+(${num}(?:\\s*(?:${GP_UNITS})\\b\\.?)?|${num}\\s*x)$`, "i"));
  if (m) return [m[1], m[2]];
  m = text.match(new RegExp(`^(${num}(?:\\s*(?:${GP_UNITS})\\b\\.?)?)\\s+(?:of\\s+)?(.+)$`, "i"));
  if (m) return [m[2], m[1]];
  return [text, ""];
}


/* Every row now carries the same field classes, so a class selector alone
 * would put the caret back in the FIRST row's price box no matter which
 * one was being typed into. The row's ingredient id is what makes the
 * restore land on the right line. */
function _gpCaptureFocus(container) {
  const el = document.activeElement;
  if (!el || !container.contains(el) || el.tagName !== "INPUT") return null;
  const row = el.closest(".gp-row");
  return { cls: el.className, value: el.value, start: el.selectionStart,
           ing: row ? row.dataset.ing : null, free: row ? row.dataset.free : null };
}
function _gpRestoreFocus(container, focus) {
  if (!focus) return;
  const selector = "." + focus.cls.trim().split(/\s+/).join(".");
  const scope = focus.ing ? container.querySelector(`.gp-row[data-ing="${focus.ing}"]`)
    : focus.free ? container.querySelector(`.gp-row[data-free="${focus.free}"]`) : container;
  const el = (scope || container).querySelector(selector);
  if (!el) return;
  if (focus.value) el.value = focus.value;
  el.focus();
  try { el.setSelectionRange(focus.start, focus.start); } catch (e) {}
}

// grams -> what a package says: ounces under a pound, then pounds (stock.us_amount)
function _gpUs(g) {
  if (!g || g <= 0) return "";
  const oz = g / 28.3495;
  if (oz < 15.95) return oz < 10 ? `${(Math.round(oz * 10) / 10).toString()} oz` : `${Math.round(oz)} oz`;
  return `${(Math.round(g / 453.592 * 10) / 10).toString()} lb`;
}

function _gpDay(iso) {
  return new Date(iso + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// The store's sizes as the choices an amount box offers while typing ("16 oz", "2 lb").
function _gpSizeList(input, sizes) {
  if (!input) return;
  const id = "gp-sizes-" + Math.random().toString(36).slice(2, 9);
  const dl = document.createElement("datalist");
  dl.id = id;
  sizes.forEach(z => {
    const o = document.createElement("option");
    o.value = z.text;
    o.label = `$${z.price.toFixed(2)} · ${z.product || z.label || ""}`;
    dl.appendChild(o);
  });
  input.after(dl);
  input.setAttribute("list", id);
}
