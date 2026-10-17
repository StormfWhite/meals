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
const GP_USUAL = '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>';
const GP_TRASH = '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>';
const gpPhone = () => window.matchMedia("(max-width: 760px)").matches;

App.groceriesPanel = {
  _container: null,
  _weekStart: null,
  _onCount: null,
  _timer: null,
  _title: "",
  _range: "",
  _shops: { grocery: null, market: null },
  _sugOpen: { grocery: false, market: false },   // phone only: the ▾ in the add bar
  _addQueue: Promise.resolve(),
  _pending: [],        // typed but still being looked up (USDA, ~3 s each): shown at once, faintly

  mount(container, weekStart, onCount, title, range) {
    this._container = container;
    this._weekStart = weekStart;
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
    const [itemsRes, ingredientsRes, freeRes, sugRes] = await Promise.all([
      App.api(`/api/groceries/${this._weekStart}`),
      App.api("/api/ingredients"),
      App.api(`/api/groceries/${this._weekStart}/free-list`),
      App.api(`/api/groceries/${this._weekStart}/suggestions`).catch(() => ({ items: [] })),
    ]);
    this._shops = { grocery: itemsRes.store, market: itemsRes.market };
    const focus = _gpCaptureFocus(this._container);
    this._draw(itemsRes.items, ingredientsRes.ingredients, freeRes.items, itemsRes.totals, sugRes.items);
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
    const datalist = container.querySelector("#gp-ingredient-catalog");
    if (datalist) datalist.innerHTML = ingredients.map(i => `<option value="${App.esc(i.name)}">`).join("");

    const rowsOf = (id) => { const el = container.querySelector(id); el.innerHTML = ""; return el; };
    const groceryRows = rowsOf("#gp-grocery-rows");
    this._fill(groceryRows, grocery, this._pending.length ? "" : "Nothing needed yet — plan some meals.");
    this._pending.forEach(p => groceryRows.appendChild(App.el(`<div class="gp-row gp-pending">
      <span class="gp-row-name">${App.esc(p.name)}</span><span class="gp-row-need dim num">${App.esc(p.qty)}</span></div>`)));
    this._fill(rowsOf("#gp-market-rows"), market, "Nothing fresh needed yet.");
    const freeRows = rowsOf("#gp-free-rows");
    freeItems.forEach(item => freeRows.appendChild(_gpSwipe(this._freeRow(item), async () => {
      await App.api(`/api/groceries/${this._weekStart}/free-list/${item.id}`, { method: "DELETE" });
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
    `;
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

  _sectionHead(kind, icon, label, rows, totals) {
    const shop = this._shops[kind];
    const total = (totals && totals[kind]) || {};
    const money = total.estimated !== null && total.estimated !== undefined
      ? `$${total.estimated.toFixed(2)}` : "";
    const missing = total.unpriced ? `<span class="gp-unpriced" title="${total.unpriced} item${total.unpriced > 1 ? "s" : ""} with no price yet">+${total.unpriced}?</span>` : "";
    return `
      <div class="gp-section-head">
        <span class="field-label">${App.icon(icon)} ${label}</span>
        <span class="dim gp-count">${rows.filter(i => !i.checked).length}</span>
        <span class="gp-total num">${money}${missing}</span>
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
    // Grouped by the meal that needs it, in the order next week cooks them; an item more than
    // one meal needs sits under the first (its tooltip names the rest). What was added by hand
    // follows under "Added" -- headed only when there are meal groups above it.
    const groups = new Map();
    [...rows].sort((a, b) => (a.meal_order ?? 1e9) - (b.meal_order ?? 1e9))
      .forEach(item => {
        const key = item.meals && item.meals.length ? item.meals[0] : "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
    const headed = [...groups.keys()].some(k => k);
    groups.forEach((items, meal) => {
      if (headed) wrap.appendChild(App.el(`<div class="gp-group">${App.icon(meal ? GP_MEAL : GP_PLUS)}<span>${App.esc(meal || "Added")}</span></div>`));
      items.forEach(item => {
        const row = this._structuredRow(item);
        if (item.meals && item.meals.length > 1) row.querySelector(".gp-row-name").title = "For " + item.meals.join(", ");
        wrap.appendChild(_gpSwipe(row, async () => {
          await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}`, { method: "DELETE" });
          App.toast(`${item.name} off the list`);
          this._reload();
        }));
      });
    });
  },

  // A usual: tap it to put it on the list, ✕ (or swipe) for not this week.
  _sugRow(sug) {
    const url = `/api/groceries/${this._weekStart}/suggestions/${encodeURIComponent(sug.key)}`;
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
    return _gpSwipe(row, dismiss);
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

    row.querySelector(".gp-chk").addEventListener("change", async (e) => {
      row.classList.toggle("done", e.target.checked);
      await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}`, { method: "PUT", body: { checked: e.target.checked } });
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
          await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}/swap`, { method: "POST", body: { to } });
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
      await App.api(`/api/groceries/${this._weekStart}/items/${item.ingredient_id}/amount`, {
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
        await App.api(`/api/groceries/${this._weekStart}/extra/${item.ingredient_id}`, { method: "DELETE" });
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
    const onEnter = (e) => { if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); addItem(); } };
    nameInput.addEventListener("keydown", onEnter);
    qtyInput.addEventListener("keydown", onEnter);
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
      await App.api(`/api/groceries/${this._weekStart}/free-list`, { method: "POST", body: { text, qty } });
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
      await App.api(`/api/groceries/${this._weekStart}/free-list/${item.id}`, { method: "PUT", body: { text } });
      this._reload();
    });
    const qtyBox = row.querySelector(".gp-row-qty");
    qtyBox.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.keyCode === 13) qtyBox.blur(); });
    qtyBox.addEventListener("change", async () => {
      await App.api(`/api/groceries/${this._weekStart}/free-list/${item.id}`, { method: "PUT", body: { qty: qtyBox.value } });
      this._reload();
    });
    row.querySelector(".gp-free-chk").addEventListener("change", async (e) => {
      row.classList.toggle("done", e.target.checked);
      await App.api(`/api/groceries/${this._weekStart}/free-list/${item.id}`, { method: "PUT", body: { checked: e.target.checked } });
      this._reload();
    });
    row.querySelector(".gp-free-remove").addEventListener("click", async () => {
      await App.api(`/api/groceries/${this._weekStart}/free-list/${item.id}`, { method: "DELETE" });
      this._reload();
    });
    return row;
  },
};

/* An amount typed into the name box, at either end: "grapes 2 lb" → ["grapes", "2 lb"],
 * "2 lb grapes" → same, "3 lemons" → ["lemons", "3"]. Kept as typed, never converted; a name
 * with no number at either end comes back whole. */
const GP_UNITS = "cups?|c|tbsps?|tablespoons?|tsps?|teaspoons?|g|grams?|kg|oz|ounces?|lbs?|pounds?|ml|l|liters?|cans?|jars?|bags?|boxe?s?|packs?|packages?|bunch(?:es)?|heads?|dozen|doz|cartons?|bottles?|loaf|loaves|gal(?:lons?)?|qt|quarts?|pints?";
function _gpSplitAmount(text) {
  const num = "\\d+(?:[./]\\d+)?(?:\\s+\\d+/\\d+)?";
  let m = text.match(new RegExp(`^(.+?)\\s+(${num}(?:\\s*(?:${GP_UNITS})\\b\\.?)?|${num}\\s*x)$`, "i"));
  if (m) return [m[1], m[2]];
  m = text.match(new RegExp(`^(${num}(?:\\s*(?:${GP_UNITS})\\b\\.?)?)\\s+(?:of\\s+)?(.+)$`, "i"));
  if (m) return [m[2], m[1]];
  return [text, ""];
}

/* Swipe a row sideways to remove it (phones). The direction is decided on
 * the first ~10px of travel, so a vertical scroll through the list is never
 * mistaken for a swipe and a tap on the checkbox is still a tap. Past a
 * third of the row's width it flies off and `onRemove` runs. */
function _gpSwipe(row, onRemove) {
  const wrap = App.el(`<div class="gp-swipe"><span class="gp-swipe-bin">${App.icon(GP_TRASH)}</span></div>`);
  wrap.appendChild(row);
  let x0 = 0, y0 = 0, dx = 0, mode = null;
  row.addEventListener("touchstart", (e) => {
    // a field being typed in keeps its touches (caret, selection); an idle name/amount still swipes
    const field = e.target.closest("input:not([type=checkbox])");
    if (e.touches.length !== 1 || (field && field === document.activeElement)) { mode = "no"; return; }
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
      onRemove();
    } else {
      row.style.transform = "";
      wrap.classList.remove("swiping", "armed");
    }
  };
  row.addEventListener("touchend", end);
  row.addEventListener("touchcancel", end);
  return wrap;
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
