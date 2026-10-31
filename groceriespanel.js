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
const GP_PANTRY = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M9.5 11v2M14.5 11v2"/>';   // the whole pantry: a wide two-door cupboard
const GP_FRIDGE = '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M5 10h14M9 5v2M9 13v3"/>';
// dry goods: a jar with its lid -- nothing like the fridge's tall box
const GP_DRY = '<path d="M8 2h8v3H8z"/><path d="M7 5h10l1 3v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8z"/><path d="M6 11h12M6 17h12"/>';
const GP_CAMERA = '<path d="M3 8a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="4"/>';
const GP_CHECK = '<path d="M20 6 9 17l-5-5"/>';
const GP_POT = '<path d="M4 10h16v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z"/><path d="M2 10h20"/><path d="M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2"/>';   // made in bulk (bulk.js)
const GP_PLACES = { fridge: [GP_FRIDGE, "Fridge"], pantry: [GP_DRY, "Dry"], freezer: [GP_SNOW, "Freezer"] };
const gpPlace = (where, cls = "") => `<span class="gp-place where-${where} ${cls}" title="${GP_PLACES[where][1]}">${App.icon(GP_PLACES[where][0])}</span>`;
const GP_BARCODE = '<path d="M4 5v14M7 5v14M11 5v14M14 5v14M18 5v14M20 5v14"/>';
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

  async _autoRestock(week) {
    const KEY = `meals.v1.autolow.${week}`;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) {}
    // Only what keeps (shelf-stable, 3+ weeks): a perishable shouldn't be bought just because the last ran
    // out -- it'd sit "on hand" and go bad. Those stay in the Pantry's Running low, one tap away.
    const need = this._stock.filter(i => i.low && !i.on_list && !i.made && (i.keep_days || 0) >= 21 && !done.includes(i.ingredient_id));
    if (!need.length) return false;
    try { localStorage.setItem(KEY, JSON.stringify(done.concat(need.map(i => i.ingredient_id)))); } catch (e) { return false; }   // can't remember = don't loop
    for (const item of need) {
      try { await App.api(`/api/groceries/${week}/extra`, { method: "POST", body: { ingredient_id: item.ingredient_id, qty: null } }); } catch (e) {}
    }
    App.toast(need.length === 1 ? `${need[0].name} added — running out` : `${need.length} running-out items added to the list`);
    return true;
  },

  async _reload() {
    if (!this._container || !this._container.isConnected) return;
    const gw = this._weekStart, mw = this._marketWeek, two = mw !== gw;
    const [gRes, ingredientsRes, freeRes, gSug, mRes, mSug, stockRes] = await Promise.all([
      App.api(`/api/groceries/${gw}`),
      App.api("/api/ingredients"),
      App.api(`/api/groceries/${mw}/free-list`),
      App.api(`/api/groceries/${gw}/suggestions`).catch(() => ({ items: [] })),
      two ? App.api(`/api/groceries/${mw}`) : null,
      two ? App.api(`/api/groceries/${mw}/suggestions`).catch(() => ({ items: [] })) : null,
      App.api(`/api/stock/${gw}`).catch(() => ({ items: [] })),
    ]);
    this._stock = stockRes.items;
    this._meals = stockRes.meals || [];
    // What's running out goes on the list by itself (once per item per week, so one that's swiped off stays off).
    if (await this._autoRestock(gw)) { this._reload(); return; }
    const low = this._stock.filter(i => i.low && !i.on_list).length;
    const pb = document.getElementById("pantry-count");
    if (pb) { pb.textContent = low ? String(low) : ""; pb.classList.toggle("on", low > 0); }
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
    const n = container.querySelector(".gp-stock-n"), low = this._stock.filter(i => i.low && !i.on_list).length;
    if (n) n.innerHTML = this._stock.length ? `${this._stock.length}${low ? ` · <span class="warn">${low} low</span>` : ""}` : "";

    container.querySelector('[data-list="grocery"] .gp-head-slot').innerHTML =
      this._sectionHead("grocery", GP_CART, "Groceries", grocery, totals);
    container.querySelector('[data-list="market"] .gp-head-slot').innerHTML =
      this._sectionHead("market", GP_BASKET, "Farmer's market", market, totals);
    container.querySelectorAll(".gp-stock-badges").forEach(b => b.addEventListener("click", () => this._toggleStock()));
    // the meal lines say where each comes from (fridge / dry / freezer / list): ask again
    if (App.plan && App.plan.refreshSources) App.plan.refreshSources();
    if (this._stockOpen) this._drawStock();

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
          <input class="gp-add-name" placeholder="Add an item…" autocomplete="off" spellcheck="false" enterkeyhint="enter">
          <input class="gp-add-qty" placeholder="qty" spellcheck="false" enterkeyhint="enter">
          ${sugToggle("grocery")}
        </div>
        <div class="gp-rows gp-sugs" id="gp-grocery-sugs"></div>
      </div>
      <div class="gp-section gp-market${open("market")}" data-list="market">
        <div class="gp-head-slot"></div>
        <div class="gp-rows" id="gp-market-rows"></div>
        <div class="gp-rows gp-free" id="gp-free-rows"></div>
        <div class="gp-add-row">
          <input class="gp-free-add" placeholder="Add a line, press Enter…" autocomplete="off" spellcheck="false" enterkeyhint="enter">
          ${sugToggle("market")}
        </div>
        <div class="gp-rows gp-sugs" id="gp-market-sugs"></div>
      </div>
      <div class="gp-section gp-stock${this._stockOpen ? " open" : ""}">
        <div class="gp-stock-headrow">
        <button class="gp-section-head gp-stock-head" title="What's in the kitchen">
          <span class="field-label">${App.icon(GP_PANTRY)} Pantry</span>
          <span class="gp-count dim num gp-stock-n"></span>
          <span class="gp-stock-chev">${App.icon(GP_DOWN)}</span>
        </button>
        <!-- in the head, not under 20+ rows: one tap whether the Pantry is open or not (Storm 2026-10-26) -->
        <label class="icon-btn gp-stock-cam" title="Photo of the fridge, pantry or freezer — fills in what's there to check and add">${App.icon(GP_CAMERA)}<input type="file" accept="image/*" hidden></label>
        <button class="icon-btn gp-stock-bar" title="Scan a barcode — fills the add row with what it is">${App.icon(GP_BARCODE)}</button>
        </div>
        <div class="gp-stock-body"${this._stockOpen ? "" : " hidden"}>
        <div class="gp-rows" id="gp-stock-rows"></div>
        <div class="gp-add-row gp-stock-addrow">
          <input class="gp-stock-name" placeholder="Add to pantry…" autocomplete="off" spellcheck="false" enterkeyhint="enter">
          <input class="gp-stock-qty" placeholder="qty" spellcheck="false" enterkeyhint="enter">
          <span class="gp-stock-pick">
            <button class="icon-btn where-fridge" data-where="fridge" title="Fridge">${App.icon(GP_FRIDGE)}</button>
            <button class="icon-btn where-pantry" data-where="pantry" title="Dry">${App.icon(GP_DRY)}</button>
            <button class="icon-btn where-freezer" data-where="freezer" title="Freezer">${App.icon(GP_SNOW)}</button>
          </span>
        </div>
        <div class="gp-scan" hidden></div>
        </div>
      </div>
    `;
    container.querySelector(".gp-stock-head").addEventListener("click", () => this._toggleStock());
    this._wireStockAdd();
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
        // ONE secondary line: which meal(s) it's for, the store's product, and a warning if it may go bad.
        // The need / on-hand / lasts-till math stays on the row, folded away: tap the line to open it.
        const forMeals = byAisle ? (item.meals || []) : (item.meals || []).slice(1);
        const bits = [];
        if (forMeals.length) bits.push(`<span class="gp-sub-meals">${App.icon(GP_MEAL)}<span>${byAisle ? "" : "also "}${App.esc(forMeals.join(" · "))}</span></span>`);
        if (item.product) bits.push(`<span class="gp-sub-prod">${App.esc(item.product)}</span>`);
        if (item.wasted_g > 0.5) bits.push(`<span class="warn" title="Won't keep till it's next used — plan a meal with it, or buy less">${App.icon(GP_WARN)} ${_gpUs(item.wasted_g)} may go bad</span>`);
        const hasMath = !!row.querySelector(".gp-math");
        if (bits.length || hasMath) {
          const sub = App.el(`<div class="gp-sub${hasMath ? " more" : ""}" title="${App.esc((item.meals || []).join(", "))}">${bits.join("")}</div>`);
          if (hasMath) sub.addEventListener("click", (e) => { if (!e.target.closest("a,button,input")) row.classList.toggle("open"); });
          const math = row.querySelector(".gp-math");
          row.insertBefore(sub, math || null);
        }
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
        row.addEventListener("click", () => this._toggleStock(true, true));
        wrap.appendChild(row);
      });
    }
  },

  // ── Pantry: what's on hand -- running low, fridge, pantry, freezer (stock.py) ──
  // the Pantry button: open it and bring it into view
  openPantry() {
    this._stockOpen = true;
    if (this._container && this._container.querySelector(".gp-stock")) this._toggleStock(true, true);
  },

  // a section of the list like the other two, under the market: one click on its heading opens it
  _toggleStock(open, scroll = false) {
    this._stockOpen = open === undefined ? !this._stockOpen : open;
    const sec = this._container.querySelector(".gp-stock");
    sec.classList.toggle("open", this._stockOpen);
    sec.querySelector(".gp-stock-body").hidden = !this._stockOpen;
    if (this._stockOpen) {
      this._drawStock();
      this._loadStock();
      if (scroll) requestAnimationFrame(() => sec.scrollIntoView({ block: "start", behavior: "smooth" }));
    }
  },

  async _loadStock() {
    const res = await App.api(`/api/stock/${this._weekStart}`).catch(() => null);
    if (res) { this._stock = res.items; this._meals = res.meals || []; this._drawStock(); }
  },

  // "garlic · 2 heads · dry": on top of what's there; no section picked = where it usually lives
  _wireStockAdd() {
    const c = this._container;
    const nameIn = c.querySelector(".gp-stock-name"), qtyIn = c.querySelector(".gp-stock-qty");
    let where = null;
    const paint = () => c.querySelectorAll(".gp-stock-pick button").forEach(x => x.classList.toggle("on", x.dataset.where === where));
    const add = async () => {
      let name = nameIn.value.trim(), qty = qtyIn.value.trim();
      if (!name) return false;
      if (!qty) [name, qty] = _gpSplitAmount(name);
      if (!qty) { qtyIn.focus(); return false; }     // the amount is the point: ask for it, keeping the place picked
      nameIn.value = ""; qtyIn.value = ""; nameIn.focus();
      await this._addStock(name, qty, where);
      where = null; paint();
      this._reload();
      return true;
    };
    // the fridge / dry / freezer icon sends it: with something typed, tapping a place adds it there at once
    c.querySelectorAll(".gp-stock-pick button").forEach(b => {
      b.addEventListener("mousedown", (e) => e.preventDefault());   // keep the keyboard / caret where it is
      b.addEventListener("click", () => {
        where = (!nameIn.value.trim() && where === b.dataset.where) ? null : b.dataset.where;   // nothing typed: it just picks (or un-picks) the place
        paint();
        if (nameIn.value.trim()) add();
      });
    });
    [nameIn, qtyIn].forEach(i => i.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      if (i === nameIn) App.ingSuggest.takeActive(nameIn);
      add();
    }));
    // what's in the catalog, and saved meals (a meal's name + a count puts meal blocks away)
    _gpSuggest(nameIn, qtyIn, { week: () => this._weekStart,
      extra: () => ((App.plan && App.plan._recipes) || []).map(r => ({ name: r.name, reason: "meal" })) });
    // a photo: what's in it comes back as rows to check (pantry_scan.py), never straight in
    c.querySelector(".gp-stock-cam input").addEventListener("change", async (e) => {
      const file = (e.target.files || [])[0];
      e.target.value = "";
      if (!file) return;
      if (!this._stockOpen) this._toggleStock(true);
      this._scan = { reading: true, where };
      this._drawScan();
      try {
        const image = await App.shrinkPhoto(file);
        const res = await App.api(`/api/stock/${this._weekStart}/scan`, { method: "POST", body: { image, where } });
        this._scan = { where: res.where, rows: res.items.map(r => ({ ...r, on: true })) };
        if (!res.items.length) { this._scan = null; App.toast("Nothing in that photo to add"); }
      } catch (err) {
        this._scan = null;
        App.toast(`Couldn't read the photo — ${err.message}`);
      }
      this._drawScan();
    });
    c.querySelector(".gp-stock-bar").addEventListener("click", () => this._barcode());
    this._drawScan();
  },

  /* A barcode -> the add row. The camera reads it where the browser can (BarcodeDetector: the
   * phone); anywhere else type it, or point a USB scanner at the box. The product comes from
   * Open Food Facts straight from the page (works on the phone build too) and lands in the
   * Pantry add row, so picking fridge / dry / freezer adds it like anything typed. */
  async _barcode() {
    if (!this._stockOpen) this._toggleStock(true);
    const box = this._container.querySelector(".gp-scan");
    box.hidden = false;
    box.innerHTML = `<div class="gp-scan-head"><span class="field-label">${App.icon(GP_BARCODE)} Barcode</span>
        <button class="icon-btn gp-scan-x" title="Close">${App.icon(GP_X)}</button></div>
      <video class="gp-bar-video" playsinline muted hidden></video>
      <input class="gp-bar-code num" inputmode="numeric" placeholder="digits under the bars" spellcheck="false" autocomplete="off">
      <div class="gp-bar-out dim"></div>`;
    const video = box.querySelector("video"), input = box.querySelector(".gp-bar-code"), out = box.querySelector(".gp-bar-out");
    let stream = null, live = true;
    const close = () => { live = false; if (stream) stream.getTracks().forEach(t => t.stop()); box.hidden = true; box.innerHTML = ""; };
    box.querySelector(".gp-scan-x").addEventListener("click", close);
    const lookup = async (code) => {
      code = code.replace(/\D/g, "");
      if (code.length < 8) return;
      out.textContent = "Looking it up…";
      try {
        const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,quantity,product_quantity`);
        const p = (await r.json()).product;
        if (!p || !p.product_name) { out.textContent = `${code}: not in Open Food Facts — type the name`; return; }
        const brand = (p.brands || "").split(",")[0].trim();
        const name = brand && !p.product_name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${p.product_name}` : p.product_name;
        const grams = Number(p.product_quantity) || 0;
        this._container.querySelector(".gp-stock-name").value = name;
        this._container.querySelector(".gp-stock-qty").value = grams ? `${Math.round(grams)} g` : (p.quantity || "");
        out.textContent = `${name} · ${p.quantity || "size unknown"} — now pick fridge, dry or freezer`;
        close_after();
      } catch (e) { out.textContent = "Couldn't reach Open Food Facts"; }
    };
    const close_after = () => { live = false; if (stream) stream.getTracks().forEach(t => t.stop()); video.hidden = true; };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lookup(input.value); } });
    input.addEventListener("input", () => { if (/^\d{12,14}$/.test(input.value.trim())) lookup(input.value); });   // a USB scanner types the digits
    input.focus();
    if (window.BarcodeDetector && navigator.mediaDevices?.getUserMedia) {
      try {
        const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream; video.hidden = false; await video.play();
        const tick = async () => {
          if (!live) return;
          try { const hits = await det.detect(video); if (hits.length) { lookup(hits[0].rawValue); return; } } catch (e) {}
          setTimeout(tick, 250);
        };
        tick();
      } catch (e) { out.textContent = "Camera not available — type the digits"; }
    } else out.textContent = "No camera scanning here — type the digits (or use a USB scanner)";
  },

  /* One item into the Pantry -- typed in the add row or ticked from a photo. True = it's in. */
  async _addStock(name, qty, where, quiet = false) {
      try {
        const ings = this._ingredients || [];
        let match = ings.find(i => (i.name || "").toLowerCase() === name.toLowerCase());
        // a meal's name and a count ("chili 4", "4 blocks"): whole meal blocks put away (batches.py)
        const meal = (App.plan && App.plan._recipes || []).find(r => (r.name || "").toLowerCase() === name.toLowerCase());
        const count = qty.match(/^\s*(\d+(?:\.\d+)?)\s*(?:blocks?|servings?|srv)?\s*$/i);
        if (meal && count && (!match || /block|serv|srv/i.test(qty))) {
          const at = where === "fridge" ? "fridge" : "freezer";
          await App.api(`/api/stock/${this._weekStart}/meals`, { method: "POST", body: { recipe_id: meal.id, n: Number(count[1]), where: at } });
          App.toast(`${meal.name}: ${count[1]} in the ${at}`);
          if (App.plan && App.plan.refreshSources) App.plan.refreshSources();
          this._reload();
          return;
        }
        if (!match) {
          match = (await App.api("/api/ingredients", { method: "POST", body: { name, default_unit: "g", resolve: false } })).ingredient;
          ings.push(match);
          App.resolveLater(match.id, () => this.refresh());
        }
        await App.api(`/api/stock/${this._weekStart}`, { method: "POST", body: { ingredient_id: match.id, text: qty, where } });
        if (!quiet) App.toast(`${name}: ${qty} in the ${where === "freezer" ? "freezer" : where === "fridge" ? "fridge" : where === "pantry" ? "pantry" : "kitchen"}`);
        return true;
      } catch (e) {
        if (!quiet) App.toast(`Couldn't add ${name} — try "8 oz", "1 lb" or "3 blocks of 1 lb"`);
        return false;
      }
  },

  /* What a photo found, to check before it goes in: tick, fix a name or an amount, tap the place
   * icon to move it, then ✓ adds the ticked ones. A row that can't be added stays, marked. */
  _drawScan() {
    const box = this._container && this._container.querySelector(".gp-scan");
    if (!box) return;
    const sc = this._scan;
    box.hidden = !sc;
    if (!sc) { box.innerHTML = ""; return; }
    if (sc.reading) {
      box.innerHTML = `<div class="gp-scan-wait"><div class="spin"></div>Reading the photo…</div>`;
      return;
    }
    const n = sc.rows.filter(r => r.on).length;
    box.innerHTML = `<div class="gp-scan-head">
        <span class="field-label">${App.icon(GP_CAMERA)} From the photo</span>
        <button class="icon-btn gp-scan-x" title="Discard">${App.icon(GP_X)}</button>
        <button class="btn-primary gp-scan-go" title="Add the ticked ones" ${n ? "" : "disabled"}>${App.icon(GP_CHECK)} ${n}</button>
      </div>`;
    const order = ["fridge", "pantry", "freezer"];
    sc.rows.forEach((r) => {
      const at = r.where || sc.where;
      const el = App.el(`<div class="gp-row gp-scan-row${r.on ? "" : " off"}${r.failed ? " failed" : ""}">
        <label class="check"><input type="checkbox" class="gp-scan-chk" ${r.on ? "checked" : ""}><span class="box">${App.icon(GP_CHECK)}</span></label>
        <input class="gp-se-name" value="${App.esc(r.name)}" spellcheck="false" title="${r.ingredient_id ? "Already in the catalog" : "New ingredient"}">
        <input class="gp-se-qty num" value="${App.esc(r.qty)}" spellcheck="false" title="${r.estimated ? "Size guessed — the label wasn't readable" : "Amount"}">
        <button class="icon-btn gp-scan-at ${at ? "where-" + at : ""}" title="${at ? GP_PLACES[at][1] + " — tap to move" : "Its usual place — tap to pick"}">${App.icon(at ? GP_PLACES[at][0] : GP_PANTRY)}</button>
      </div>`);
      if (r.estimated) el.querySelector(".gp-se-qty").classList.add("guess");
      el.querySelector(".gp-scan-chk").addEventListener("change", (e) => { r.on = e.target.checked; this._drawScan(); });
      const nm = el.querySelector(".gp-se-name");
      nm.addEventListener("input", (e) => { r.name = e.target.value; r.ingredient_id = null; });
      // the catalog's own name, picked from the dropdown, ties it to that ingredient
      _gpSuggest(nm, null, { week: () => this._weekStart, onPick: (item) => { r.name = item.name; r.ingredient_id = item.id || null; } });
      nm.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); App.ingSuggest.takeActive(nm); nm.blur(); } });
      el.querySelector(".gp-se-qty").addEventListener("input", (e) => { r.qty = e.target.value; r.estimated = false; });
      el.querySelector(".gp-scan-at").addEventListener("click", () => {
        r.where = order[(order.indexOf(at) + 1) % order.length];
        this._drawScan();
      });
      box.appendChild(el);
    });
    box.querySelector(".gp-scan-x").addEventListener("click", () => { this._scan = null; this._drawScan(); });
    box.querySelector(".gp-scan-go").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      let added = 0;
      for (const r of sc.rows.filter(x => x.on && x.name.trim())) {
        if (await this._addStock(r.name.trim(), r.qty.trim() || "1", r.where || sc.where, true)) { r.added = true; added++; }
        else r.failed = true;
      }
      sc.rows = sc.rows.filter(r => !r.added && r.on);
      if (!sc.rows.length) this._scan = null;
      App.toast(`${added} added${sc.rows.length ? ` · ${sc.rows.length} need an amount it can weigh` : ""}`);
      this._drawScan();
      this._reload();
    });
  },

  _drawStock() {
    const wrap = this._container.querySelector("#gp-stock-rows");
    if (!wrap) return;                    // the plan was left while the stock was loading
    const items = this._stock || [], meals = this._meals || [];
    wrap.innerHTML = "";
    if (!items.length && !meals.length) {
      wrap.appendChild(App.el(`<div class="gp-empty">Nothing yet — add what's in the kitchen below; what's bought beyond the week's meals shows up here too.</div>`));
      return;
    }
    const put = async (item, body) => {
      await App.api(`/api/stock/${this._weekStart}/${item.ingredient_id}`, { method: "PUT", body });
      this._reload();
    };
    const head = (icon, label, cls = "") => wrap.appendChild(App.el(`<div class="gp-stock-sub ${cls}">${App.icon(icon)}<span>${label}</span></div>`));
    const wk = this._weekStart, soon = _gpAddDays(wk, 10);
    const day = (iso) => iso <= wk ? "this week" : "~" + _gpDay(iso);
    const when = (item) => {
      // goes off before it's used up -- months away (rice, oil) isn't worth saying
      if (item.use_by && item.use_by <= _gpAddDays(wk, 90) && (!item.runs_out || item.use_by < item.runs_out))
        return `<span class="gp-stock-when${item.use_by <= soon ? " warn" : ""}" title="Won't keep past this">use by ${day(item.use_by)}</span>`;
      return item.runs_out ? `<span class="gp-stock-when" title="When it has to be bought again">out ${day(item.runs_out)}</span>` : "";
    };
    // this week's meals take some: what's left after them
    const left = (item) => item.uses_g > 0.5 && item.left_text      // "→ 0" says nothing "out this week" doesn't
      ? `<span class="gp-stock-left dim num" title="Left after this week's meals">→ ${App.esc(item.left_text || "0")}</span>` : "";
    const rmBtn = `<button class="icon-btn gp-stock-rm" title="Remove (used up)">${App.icon(GP_X)}</button>`;
    const keyOf = (item, frozen) => item.ingredient_id + (frozen ? ":f" : "");

    // one click on a row: name, amount and place, all editable in the row itself
    const editor = (item, frozen) => {
      const at = frozen ? "freezer" : item.where;
      const text = frozen ? item.freezer_text : item.fridge_text;
      let to = at;
      const el = App.el(`<div class="gp-row gp-stock-row gp-stock-edit">
        <input class="gp-se-name" value="${App.esc(item.name)}" spellcheck="false" enterkeyhint="done" title="Name">
        <input class="gp-se-qty num" value="${App.esc(text)}" placeholder="qty" spellcheck="false" enterkeyhint="done" title="How much there is">
        <span class="gp-stock-pick">${Object.keys(GP_PLACES).map(w =>
          `<button class="icon-btn where-${w}${w === at ? " on" : ""}" data-where="${w}" title="${GP_PLACES[w][1]}">${App.icon(GP_PLACES[w][0])}</button>`).join("")}</span>
        <button class="icon-btn gp-se-ok" title="Save">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</button>
      </div>`);
      const nameIn = el.querySelector(".gp-se-name"), qtyIn = el.querySelector(".gp-se-qty");
      el.querySelectorAll(".gp-stock-pick button").forEach(b => b.addEventListener("click", () => {
        to = b.dataset.where;
        el.querySelectorAll(".gp-stock-pick button").forEach(x => x.classList.toggle("on", x === b));
      }));
      const save = async () => {
        this._stockEdit = null;
        const name = nameIn.value.trim(), qty = qtyIn.value.trim();
        try {
          if (qty !== text) await App.api(`/api/stock/${wk}/${item.ingredient_id}`, { method: "PUT", body: { text: qty || "0", frozen } });
          if (to !== at) await App.api(`/api/stock/${wk}/${item.ingredient_id}/where`, { method: "PUT", body: { to, frozen } });
          if (name && name !== item.name) {
            const res = await App.api(`/api/ingredients/${item.ingredient_id}`, { method: "PUT", body: { name } });
            if (res.merged) App.toast(`Merged into ${res.ingredient.name}`);
          }
        } catch (e) { App.toast(`Couldn't save ${item.name}`); }
        this._reload();
      };
      const cancel = () => { this._stockEdit = null; this._drawStock(); };
      el.querySelector(".gp-se-ok").addEventListener("click", save);
      [nameIn, qtyIn].forEach(i => i.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.keyCode === 13) {
          e.preventDefault();
          if (i === nameIn) App.ingSuggest.takeActive(nameIn);   // a typo fixed into the real name merges them
          save();
        } else if (e.key === "Escape" && !App.ingSuggest.isOpen()) cancel();
      }));
      _gpSuggest(nameIn, null, { week: () => wk });
      requestAnimationFrame(() => { qtyIn.focus(); qtyIn.select(); });
      return el;
    };

    const row = (item, frozen, extra = "") => {
      if (this._stockEdit === keyOf(item, frozen)) return editor(item, frozen);
      const text = frozen ? item.freezer_text : item.fridge_text;
      const el = App.el(`<div class="gp-row gp-stock-row" title="Click to change the name, amount or place">
        ${gpPlace(frozen ? "freezer" : item.where)}
        <span class="gp-row-name">${App.esc(item.name)}</span>
        <span class="gp-stock-amt num">${App.esc(text || "—")}</span>
        ${frozen ? "" : left(item)}
        ${when(item)}
        ${extra}
        ${rmBtn}
      </div>`);
      el.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        this._stockEdit = keyOf(item, frozen);
        this._drawStock();
      });
      el.querySelector(".gp-stock-rm").addEventListener("click", async () => {
        App.toast(`${item.name}: removed`); await put(item, { grams: 0, frozen });
      });
      return App.swipeAway(el, async () => { App.toast(`${item.name}: used up`); await put(item, { grams: 0, frozen }); });
    };

    // running low first: each one a tap from the list
    const low = items.filter(i => i.low);
    if (low.length) {
      head(GP_WARN, "Running low", "low");
      low.forEach(item => {
        const frozen = !(item.fridge_g > 0.5);
        if (item.made) {
          // made at home in bulk: never bought -- the pot icon opens Bulk to make it again
          const el = row(item, frozen, `<button class="gp-stock-add" title="Make more">${App.icon(GP_POT)}</button>`);
          el.querySelector(".gp-stock-add").addEventListener("click", (e) => { e.stopPropagation(); App.setView("bulk"); });
          wrap.appendChild(el);
          return;
        }
        const el = row(item, frozen, `<button class="gp-stock-add${item.on_list ? " done" : ""}" ${item.on_list ? "disabled" : ""}>${item.on_list ? "on list" : "+ list"}</button>`);
        el.querySelector(".gp-stock-add")?.addEventListener("click", async () => {
          await App.api(`/api/groceries/${wk}/extra`, { method: "POST", body: { ingredient_id: item.ingredient_id, qty: null } });
          App.toast(`${item.name} on the list`);
          this._reload();
        });
        wrap.appendChild(el);
      });
    }
    // cooked meals put away from a batch (batches.py): servings, not grams
    const mealRow = (m) => {
      const setN = async (n) => {
        const res = await App.api(`/api/stock/${wk}/meals/${m.recipe_id}`, { method: "PUT", body: { where: m.where, n } });
        this._stock = res.items; this._meals = res.meals; this._drawStock();
        if (App.plan && App.plan.refreshSources) App.plan.refreshSources();
        this.refresh();
      };
      const el = App.el(`<div class="gp-row gp-stock-row gp-stock-meal" title="Cooked ${_gpDay(m.made)} — − when one's eaten">
        <span class="gp-place where-${m.where}">${App.icon(GP_MEAL)}</span>
        <span class="gp-row-name">${App.esc(m.name)}</span>
        <button class="icon-btn gp-meal-dn" title="One eaten">−</button>
        <span class="gp-stock-amt num" title="${m.where === "freezer" ? "frozen meal blocks" : "servings"}">${m.n} ${m.where === "freezer" ? (m.n === 1 ? "block" : "blocks") : "srv"}</span>
        ${m.where === "fridge" || m.use_by <= soon ? `<span class="gp-stock-when${m.use_by <= soon ? " warn" : ""}" title="Won't keep past this">use by ${day(m.use_by)}</span>` : ""}
        ${rmBtn}
      </div>`);
      el.querySelector(".gp-meal-dn").addEventListener("click", () => setN(Math.max(0, m.n - 1)));
      el.querySelector(".gp-stock-rm").addEventListener("click", () => { App.toast(`${m.name}: gone`); setN(0); });
      return App.swipeAway(el, () => { App.toast(`${m.name}: gone`); return setN(0); });
    };
    const rest = items.filter(i => !i.low);
    ["fridge", "pantry"].forEach(where => {
      const mine = rest.filter(i => i.where === where && i.fridge_g > 0.5);
      const cooked = meals.filter(m => m.where === where);
      if (!mine.length && !cooked.length) return;
      head(GP_PLACES[where][0], GP_PLACES[where][1], "where-" + where);
      cooked.forEach(m => wrap.appendChild(mealRow(m)));
      mine.forEach(i => wrap.appendChild(row(i, false)));
    });
    const frozen = rest.filter(i => i.freezer_g > 0.5);
    const frozenMeals = meals.filter(m => m.where === "freezer");
    if (frozen.length || frozenMeals.length) {
      head(GP_SNOW, "Freezer", "where-freezer");
      frozenMeals.forEach(m => wrap.appendChild(mealRow(m)));
      frozen.forEach(i => wrap.appendChild(row(i, true)));
    }
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
      ${item.low_stock ? `<button class="icon-btn gp-low" title="Low or out here — where else nearby has it?">${App.icon(GP_WARN)}</button>` : ""}
      <button class="icon-btn gp-move" title="Move to the ${other === "market" ? "farmer's market" : "grocery"} list">${App.icon(GP_SWAP)}</button>
      <button class="icon-btn gp-del" title="Take it off the list">${App.icon(GP_X)}</button>
      ${item.source === "extra" ? `<button class="icon-btn gp-row-remove-extra" title="Remove the amount added by hand">${App.icon(GP_X)}</button>` : ""}
    </div>`);

    const math = this._mathLine(item);
    if (math) row.appendChild(math);
    const lowBtn = row.querySelector(".gp-low");
    if (lowBtn) lowBtn.addEventListener("click", async () => {
      let box = row.querySelector(".gp-else");
      if (box) { box.remove(); return; }
      box = App.el(`<div class="gp-else"><span class="gp-else-note">Checking nearby stores…</span></div>`);
      row.appendChild(box);
      let res;
      try { res = await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}/elsewhere`); }
      catch (e) { box.innerHTML = `<span class="gp-else-note">Couldn't check: ${App.esc(e.message)}</span>`; return; }
      box.innerHTML = res.stores.length ? res.stores.map(s => `
        <div class="gp-else-row">
          <a href="${App.esc(s.store_url)}" target="_blank" rel="noopener" class="gp-else-store" title="Open the store">${App.esc(s.name)}</a>
          <span class="num">${s.distance_km} km</span>
          <a href="${App.esc(s.product_url || s.store_url)}" target="_blank" rel="noopener" class="gp-else-item" title="${App.esc(s.label)}">$${s.price.toFixed(2)} ${App.esc(s.label)}</a>
        </div>`).join("")
        : `<span class="gp-else-note">${res.checked ? `None of ${res.checked} nearby stores has it either.` : "No other Kroger-family store to check nearby."}</span>`;
    });
    if (item.sizes && item.sizes.length) _gpSizeList(row.querySelector(".gp-row-qty"), item.sizes);

    row.querySelector(".gp-chk").addEventListener("change", async (e) => {
      row.classList.toggle("done", e.target.checked);
      if (e.target.checked) window.MealsAndroid?.shopping?.();   // the phone starts watching for leaving the shop
      await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}`, { method: "PUT", body: { checked: e.target.checked } });
      // the row already changed under your finger; the totals catch up once you pause (a redraw per tick is the lag)
      clearTimeout(this._tickTimer);
      this._tickTimer = setTimeout(() => this._reload().catch(() => {}), 2500);
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
      const taken = this._ingredients.find(i => (i.name || "").toLowerCase() === name.toLowerCase() && i.id !== item.ingredient_id);
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

    row.querySelector(".gp-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      // gone from the screen at once; the list math (slow on a phone) catches up behind it
      const box = row.closest(".gp-swipe") || row;
      box.style.display = "none";
      await App.api(`/api/groceries/${this._wk(item.shop_list)}/items/${item.ingredient_id}`, { method: "DELETE" });
      App.toast(`${item.name} off the list`);
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
        let match = ingredients.find(i => (i.name || "").toLowerCase() === name.toLowerCase());
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
    const onEnter = (e) => {
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      if (e.target === nameInput) App.ingSuggest.takeActive(nameInput);   // "ban" + Enter = banana
      addItem(); sizesFor = "";
    };
    nameInput.addEventListener("keydown", onEnter);
    qtyInput.addEventListener("keydown", onEnter);
    _gpSuggest(nameInput, qtyInput, { week: () => this._weekStart, onPick: () => offerSizes() });
    // something the store has been asked about before: its sizes are offered in the amount box
    let sizesFor = "";
    const offerSizes = async () => {
      const name = nameInput.value.trim().toLowerCase();
      const match = name && (this._ingredients || []).find(i => (i.name || "").toLowerCase() === name);
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
    _gpSuggest(freeAdd, null, { week: () => this._marketWeek });
    freeAdd.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      App.ingSuggest.takeActive(freeAdd);
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
      (row.closest(".gp-swipe") || row).style.display = "none";    // at once; the redraw catches up
      await App.api(`/api/groceries/${this._marketWeek}/free-list/${item.id}`, { method: "DELETE" });
      this._reload();
    });
    return row;
  },
};

/* An amount typed into the name box, at either end: "grapes 2 lb" → ["grapes", "2 lb"],
 * "2 lb grapes" → same, "3 lemons" → ["lemons", "3"]. Kept as typed, never converted; a name
 * with no number at either end comes back whole. */
const GP_UNITS = "blocks?|servings?|cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|g|grams?|kg|oz|ounces?|lbs?|pounds?|ml|l|liters?|cans?|jars?|bags?|boxe?s?|packs?|packages?|bunch(?:es)?|heads?|dozen|doz|cartons?|bottles?|loaf|loaves|gal(?:lons?)?|qt|quarts?|pints?";
function _gpRange(week) {   // "Oct 25 – Oct 31", via plan.js's own formatter
  return typeof _planRange === "function" ? _planRange(week, _planShift(week, 6)) : week;
}

/* The ranked ingredient dropdown (ingsuggest.js) on an add box. Only the name part of "grapes 2 lb"
 * is looked up; picking a row keeps the amount -- into the qty box when there is one, else back
 * on the line ("6 peac" -> "Peaches 6"). Opens once typing starts, never on a bare tap. */
function _gpSuggest(input, qtyInput, opts = {}) {
  App.ingSuggest.attach(input, {
    minChars: 1,
    query: (text) => { const [name, qty] = _gpSplitAmount(text); return qty ? name : text; },
    context: () => ({ week: opts.week ? opts.week() : "" }),
    extra: opts.extra,
    onPick: (item, el, before) => {
      const [, qty] = _gpSplitAmount(before || "");
      if (qty && qtyInput && !qtyInput.value.trim()) qtyInput.value = qty;
      else if (qty && !qtyInput) el.value = `${item.name} ${qty}`;
      if (opts.onPick) opts.onPick(item);
    },
  });
}

function _gpSplitAmount(text) {
  const num = "\\d+(?:[./]\\d+)?(?:\\s+\\d+/\\d+)?";
  // several of one size: "4 32 oz cans tomatoes", "tomatoes 4 x 32 oz", "4 (15 oz) cans of beans"
  const size = `\\(?\\s*\\d+(?:\\.\\d+)?\\s*-?\\s*(?:fl\\.?\\s*oz|oz|ounces?|lbs?|pounds?|kg|g|grams?|ml|l)\\.?\\s*\\)?`;
  const pack = "blocks?|cans?|jars?|bags?|boxe?s?|bottles?|cartons?|packages?|pkgs?|packs?|tubs?|tins?|pouch(?:es)?|containers?";
  // a space or x / × / * after the count: "32 oz" is one size, never 3 × "2 oz"
  const multi = `\\d+(?:\\.\\d+)?(?:\\s*(?:x|×|\\*)\\s*|\\s+)${size}(?:\\s*(?:${pack})\\b)?|\\d+(?:\\.\\d+)?\\s*(?:${pack})\\s*(?:of\\s*)?${size}`;
  let m = text.match(new RegExp(`^(${multi})\\s+(?:of\\s+)?(.+)$`, "i"));
  if (m) return [m[2], m[1]];
  m = text.match(new RegExp(`^(.+?)\\s+(${multi})$`, "i"));
  if (m) return [m[1], m[2]];
  m = text.match(new RegExp(`^(.+?)\\s+(${num}(?:\\s*(?:${GP_UNITS})\\b\\.?)?|${num}\\s*x)$`, "i"));
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

function _gpAddDays(iso, n) {
  const d = new Date(iso + "T00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
