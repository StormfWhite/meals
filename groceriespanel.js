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
 */
window.App = window.App || {};

const GP_CART = '<path d="M6 6h15l-2 9H8L5 3H2"/><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/>';
const GP_BASKET = '<path d="M3 9h18l-1.5 11H4.5Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>';
const GP_SWAP = '<path d="M7 4 3 8l4 4"/><path d="M3 8h14"/><path d="m17 20 4-4-4-4"/><path d="M21 16H7"/>';
const GP_COPY = '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>';
const GP_X = '<path d="M18 6 6 18M6 6l12 12"/>';

App.groceriesPanel = {
  _container: null,
  _weekStart: null,
  _onCount: null,
  _timer: null,
  _title: "",
  _range: "",
  _shops: { grocery: null, market: null },

  mount(container, weekStart, onCount, title, range) {
    this._container = container;
    this._weekStart = weekStart;
    this._onCount = onCount || null;
    this._title = title || "This week";
    this._range = range || "";
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
    const [itemsRes, ingredientsRes, freeRes] = await Promise.all([
      App.api(`/api/groceries/${this._weekStart}`),
      App.api("/api/ingredients"),
      App.api(`/api/groceries/${this._weekStart}/free-list`),
    ]);
    this._shops = { grocery: itemsRes.store, market: itemsRes.market };
    const focus = _gpCaptureFocus(this._container);
    this._draw(itemsRes.items, ingredientsRes.ingredients, freeRes.items, itemsRes.totals);
    _gpRestoreFocus(this._container, focus);
    if (this._onCount) {
      this._onCount(itemsRes.items.filter(i => !i.checked).length + freeRes.items.filter(i => !i.checked).length);
    }
  },

  _draw(items, ingredients, freeItems, totals) {
    const container = this._container;
    const grocery = items.filter(i => i.shop_list !== "market");
    const market = items.filter(i => i.shop_list === "market");

    container.innerHTML = `
      <div class="gp-head">
        <span class="gp-head-title">${App.esc(this._title)}</span>
        <span class="gp-head-range dim num">${App.esc(this._range)}</span>
      </div>
      <div class="gp-section" data-list="grocery">
        ${this._sectionHead("grocery", GP_CART, "Groceries", grocery, totals)}
        <div class="gp-rows" id="gp-grocery-rows"></div>
        <div class="gp-add-row">
          <input class="gp-add-name" list="gp-ingredient-catalog" placeholder="Add an item…" spellcheck="false">
          <input class="gp-add-qty num" placeholder="qty">
          <span class="gp-add-unit dim"></span>
        </div>
        <datalist id="gp-ingredient-catalog">${ingredients.map(i => `<option value="${App.esc(i.name)}">`).join("")}</datalist>
      </div>
      <div class="gp-section gp-market" data-list="market">
        ${this._sectionHead("market", GP_BASKET, "Farmer's market", market, totals)}
        <div class="gp-rows" id="gp-market-rows"></div>
        <div class="gp-rows gp-free" id="gp-free-rows"></div>
        <input class="gp-free-add" placeholder="Add a line, press Enter…" spellcheck="false">
      </div>
    `;

    this._fill(container.querySelector("#gp-grocery-rows"), grocery,
               "Nothing needed yet — plan some meals.");
    this._fill(container.querySelector("#gp-market-rows"), market,
               "Nothing fresh needed yet.");

    const freeRows = container.querySelector("#gp-free-rows");
    freeItems.forEach(item => freeRows.appendChild(this._freeRow(item)));

    this._wireStoreHeads();
    this._wireAdd(ingredients);
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
      wrap.appendChild(App.el(`<div class="gp-empty">${App.esc(emptyText)}</div>`));
      return;
    }
    rows.forEach(item => wrap.appendChild(this._structuredRow(item)));
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
      <span class="gp-row-name" title="${App.esc(item.price_label || item.name)}">${App.esc(item.name)}</span>
      <span class="gp-row-need dim num">${App.esc(item.unit_label)}</span>
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

  _wireAdd(ingredients) {
    const container = this._container;
    const nameInput = container.querySelector(".gp-add-name");
    const qtyInput = container.querySelector(".gp-add-qty");
    const unitLabel = container.querySelector(".gp-add-unit");
    nameInput.addEventListener("input", () => {
      const match = ingredients.find(i => i.name.toLowerCase() === nameInput.value.trim().toLowerCase());
      unitLabel.textContent = match ? match.default_unit : "";
    });
    const addItem = async () => {
      const name = nameInput.value.trim();
      if (!name) return;
      let match = ingredients.find(i => i.name.toLowerCase() === name.toLowerCase());
      const qty = Number(qtyInput.value);
      if (!qty) { App.toast("Enter a quantity"); return; }
      // Something not in the catalog yet is created (and matched to USDA)
      // rather than refused -- the list is allowed to teach the catalog.
      if (!match) {
        const created = await App.api("/api/ingredients", { method: "POST", body: { name, default_unit: "g" } });
        match = created.ingredient;
        ingredients.push(match);
      }
      const qty_g = _toGramsGP(match, qty);
      if (qty_g === null) { App.toast(`Don't know how to convert ${match.default_unit} to grams for ${match.name}`); return; }
      await App.api(`/api/groceries/${this._weekStart}/extra`, { method: "POST", body: { ingredient_id: match.id, qty_g } });
      nameInput.value = ""; qtyInput.value = ""; unitLabel.textContent = "";
      this._reload();
    };
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });
    qtyInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });

    container.querySelectorAll(".gp-copy").forEach(btn => {
      btn.addEventListener("click", async () => {
        const kind = btn.dataset.list;
        const rows = Array.from(container.querySelectorAll(`.gp-section[data-list="${kind}"] .gp-row`));
        const text = rows.map(r => {
          const name = r.querySelector(".gp-row-name").textContent;
          const need = r.querySelector(".gp-row-need");
          return `- ${need ? need.textContent + " " : ""}${name}`;
        }).join("\n") || "(nothing needed)";
        navigator.clipboard.writeText(text).then(() => App.toast("Copied"));
      });
    });
  },

  _wireFree() {
    const freeAdd = this._container.querySelector(".gp-free-add");
    freeAdd.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const text = freeAdd.value.trim();
      if (!text) return;
      freeAdd.value = "";
      await App.api(`/api/groceries/${this._weekStart}/free-list`, { method: "POST", body: { text } });
      this._reload();
    });
  },

  _freeRow(item) {
    const row = App.el(`<div class="gp-row ${item.checked ? "done" : ""}">
      <label class="check"><input type="checkbox" class="gp-free-chk" ${item.checked ? "checked" : ""}><span class="box">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span></label>
      <span class="gp-row-name">${App.esc(item.text)}</span>
      <button class="icon-btn gp-free-remove" title="Remove">${App.icon(GP_X)}</button>
    </div>`);
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

function _toGramsGP(ingredient, qty) {
  const unit = ingredient.default_unit || "g";
  if (unit === "g") return qty;
  const perUnit = (ingredient.unit_conversions || {})[unit];
  return perUnit ? qty * perUnit : null;
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
           ing: row ? row.dataset.ing : null };
}
function _gpRestoreFocus(container, focus) {
  if (!focus) return;
  const selector = "." + focus.cls.trim().split(/\s+/).join(".");
  const scope = focus.ing ? container.querySelector(`.gp-row[data-ing="${focus.ing}"]`) : container;
  const el = (scope || container).querySelector(selector);
  if (!el) return;
  if (focus.value) el.value = focus.value;
  el.focus();
  try { el.setSelectionRange(focus.start, focus.start); } catch (e) {}
}
