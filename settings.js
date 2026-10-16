/* Settings — household members + targets, re-up day, USDA FDC key
 * (key field wires up fully in Phase 3; the field itself lives here now
 * so Settings doesn't need restructuring later). */
window.App = window.App || {};

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const CATEGORIES = ["vegetable", "protein", "grain", "dairy", "fruit", "other"];

App.settings = {
  _members: [],
  _config: { reup_day: "sunday", fdc_key_set: false, kroger_key_set: false },
  _ingredients: [],
  _places: [],
  _active: null,
  _routines: [],

  async render(body) {
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    const [membersRes, configRes, ingredientsRes, placesRes, routinesRes] = await Promise.all([
      App.api("/api/household/members"),
      App.api("/api/config"),
      App.api("/api/ingredients"),
      App.api("/api/places"),
      App.api("/api/routines"),
    ]);
    this._members = membersRes.members;
    this._config = configRes;
    this._ingredients = ingredientsRes.ingredients;
    this._places = placesRes.places;
    this._active = placesRes.active;
    this._routines = routinesRes.routines;
    this._draw(body);
  },

  _draw(body) {
    const members = this._members;
    body.innerHTML = `
      <div class="pad">
        <div class="modal-section" style="border-top:none;padding-top:0;">
          <h2 style="font-size:13px;">Where you cook, and where you shop</h2>
          <div class="modal-hint">
            Each place remembers its own grocery store and farmer's market, so switching
            between them switches both lists' prices. Stores come from OpenStreetMap — type
            a name and pick the real one.
          </div>
          <div id="place-list" style="display:flex;flex-direction:column;gap:6px;"></div>
          <button class="btn-ghost" id="add-place-btn" style="align-self:flex-start;">+ Add a place</button>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Repeating meals</h2>
          <div class="modal-hint">Set from the ⟳ on any meal. A rule fills every week you haven't already planned.</div>
          <div id="routine-list" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Household members</h2>
          <div id="member-list" style="display:flex;flex-direction:column;gap:6px;"></div>
          <button class="btn-ghost" id="add-member-btn" style="align-self:flex-start;">+ Add member</button>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Grocery re-up day</h2>
          <div class="modal-hint">The day your week resets on the Board and Groceries panel.</div>
          <div class="seg" id="reup-seg">
            ${DAYS.map(d => `<button data-day="${d}" class="${d === this._config.reup_day ? "active" : ""}">${d[0].toUpperCase() + d.slice(1, 3)}</button>`).join("")}
          </div>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">USDA FoodData Central</h2>
          <div class="modal-hint">
            Ingredient nutrition search uses USDA's free FoodData Central API.
            Get a key at <a href="https://api.data.gov/signup/" target="_blank">api.data.gov/signup</a>.
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="fdc-key" type="password" placeholder="${this._config.fdc_key_set ? "•••••••••••••• (key set)" : "paste your API key"}" style="flex:1;">
            <button class="btn-ghost" id="fdc-save">Save</button>
            <button class="btn-ghost" id="fdc-test">Test key</button>
          </div>
          <div id="fdc-test-result" class="modal-hint"></div>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Store prices (optional)</h2>
          <div class="modal-hint">
            Kroger's public API covers Harris Teeter, Fred Meyer, Ralphs, King Soopers and the
            rest of their banners — if your store is one of them, prices fill in live. Free
            self-serve key at <a href="https://developer.kroger.com/" target="_blank">developer.kroger.com</a>
            (create an app, scope <code>product.compact</code>). Without it, prices are simply
            whatever you last typed for each item, remembered per store.
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <input id="kroger-id" placeholder="${this._config.kroger_key_set ? "•••••••• (client id set)" : "client id"}" style="flex:1;">
            <input id="kroger-secret" type="password" placeholder="${this._config.kroger_key_set ? "•••••••• (secret set)" : "client secret"}" style="flex:1;">
            <button class="btn-ghost" id="kroger-save">Save</button>
          </div>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Danger zone</h2>
          <div class="modal-hint">Clears logged outcomes, rolling averages and nudges. Recipes, the board and groceries are untouched.</div>
          <button class="btn-ghost btn-danger" id="clear-learning-btn" style="align-self:flex-start;">Clear learning history</button>
        </div>

        <div class="modal-section">
          <h2 style="font-size:13px;">Ingredients</h2>
          <div class="modal-hint">
            Anything typed into a meal is matched to a real USDA food straight away — that's
            where its nutrition, its cup/clove weights and the list it belongs on come from.
            Use this to catch up anything typed before that, or to correct a match.
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <button class="btn-ghost" id="resolve-all">Match everything to USDA</button>
            <span id="resolve-result" class="modal-hint"></span>
          </div>
          <div id="ingredient-list" style="display:flex;flex-direction:column;gap:6px;"></div>
        </div>
      </div>`;

    const list = body.querySelector("#member-list");
    if (members.length === 0) {
      list.innerHTML = `<div class="modal-hint">No household members yet — add one to start tracking nutrition targets.</div>`;
    } else {
      members.forEach(m => list.appendChild(this._memberRow(m)));
    }

    body.querySelector("#add-member-btn").addEventListener("click", () => this._openMemberModal(null));
    body.querySelectorAll("#reup-seg button").forEach(btn => {
      btn.addEventListener("click", async () => {
        this._config = await App.api("/api/config", { method: "POST", body: { reup_day: btn.dataset.day } });
        this._draw(body);
      });
    });

    body.querySelector("#fdc-save").addEventListener("click", async () => {
      const key = document.getElementById("fdc-key").value.trim();
      if (!key) { App.toast("Paste a key first"); return; }
      this._config = await App.api("/api/config", { method: "POST", body: { usda_fdc_api_key: key } });
      App.toast("USDA key saved");
      this._draw(body);
    });
    body.querySelector("#fdc-test").addEventListener("click", async () => {
      const el = document.getElementById("fdc-test-result");
      el.textContent = "Testing…";
      try {
        const res = await App.api("/api/ingredients/fdc-search?q=apple");
        el.textContent = res.results.length
          ? `✓ Working — found ${res.results.length} match${res.results.length === 1 ? "" : "es"} for "apple".`
          : "Key accepted, but no results came back — unexpected.";
      } catch (e) {
        el.textContent = `✗ ${e.message}`;
      }
    });

    body.querySelector("#clear-learning-btn").addEventListener("click", async () => {
      if (!confirm("Clear all learning history? This can't be undone.")) return;
      await App.api("/api/learning", { method: "DELETE" });
      App.toast("Learning history cleared");
    });

    const placeList = body.querySelector("#place-list");
    if (this._places.length === 0) {
      placeList.innerHTML = `<div class="modal-hint">No place set yet — add one and the store list will know what's near you.</div>`;
    } else {
      this._places.forEach(p => placeList.appendChild(this._placeRow(p, body)));
    }
    body.querySelector("#add-place-btn").addEventListener("click", (e) => {
      App.storePicker.open(e.target, {
        kind: "grocery",
        onPick: () => this.render(body),
      });
      // the picker asks for a place first when there isn't one; when there
      // already is, hand it straight to the place search
      setTimeout(() => App.storePicker._enterPlaceMode("grocery"), 0);
    });

    const routineList = body.querySelector("#routine-list");
    if (this._routines.length === 0) {
      routineList.innerHTML = `<div class="modal-hint">Nothing repeats yet.</div>`;
    } else {
      this._routines.forEach(r => routineList.appendChild(this._routineRow(r, body)));
    }

    body.querySelector("#kroger-save").addEventListener("click", async () => {
      const id = document.getElementById("kroger-id").value.trim();
      const secret = document.getElementById("kroger-secret").value.trim();
      if (!id || !secret) { App.toast("Both the client id and the secret are needed"); return; }
      this._config = await App.api("/api/config", {
        method: "POST", body: { kroger_client_id: id, kroger_client_secret: secret },
      });
      App.toast("Store price key saved");
      this._draw(body);
    });

    body.querySelector("#resolve-all").addEventListener("click", async () => {
      const out = document.getElementById("resolve-result");
      out.textContent = "Matching…";
      try {
        const res = await App.api("/api/ingredients/resolve-all", { method: "POST" });
        this._ingredients = res.ingredients;
        out.textContent = `matched ${res.matched.length}` +
          (res.unmatched.length ? ` · no confident match for ${res.unmatched.slice(0, 4).join(", ")}${res.unmatched.length > 4 ? "…" : ""}` : "");
        this._draw(body);
      } catch (e) { out.textContent = e.message; }
    });

    const ingList = body.querySelector("#ingredient-list");
    if (this._ingredients.length === 0) {
      ingList.innerHTML = `<div class="modal-hint">No ingredients yet.</div>`;
    } else {
      this._ingredients.forEach(i => ingList.appendChild(this._ingredientRow(i)));
    }
  },

  _placeRow(place, body) {
    const isActive = this._active && this._active.id === place.id;
    const row = App.el(`<div class="item-row">
      <span class="name">${_esc(place.label)}${isActive ? " ·" : ""}</span>
      <span class="meta">${_esc(place.address || "")}</span>
      <button class="btn-ghost btn-mini pick-store">${place.store ? _esc(place.store.name) : "pick store"}</button>
      <button class="btn-ghost btn-mini pick-market">${place.market ? _esc(place.market.name) : "pick market"}</button>
      ${isActive ? "" : `<button class="btn-ghost btn-mini use-btn">Use</button>`}
      <button class="icon-btn del-btn" title="Remove">${App.icon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>')}</button>
    </div>`);

    const pick = (kind) => (e) => {
      App.storePicker.open(e.target, {
        kind,
        current: kind === "market" ? place.market : place.store,
        onPick: async (shop) => {
          await App.api(`/api/places/${place.id}`, {
            method: "PUT", body: kind === "market" ? { market: shop } : { store: shop },
          });
          App.toast(`${place.label}: ${shop.name}`);
          this.render(body);
        },
      });
    };
    row.querySelector(".pick-store").addEventListener("click", pick("grocery"));
    row.querySelector(".pick-market").addEventListener("click", pick("market"));
    const useBtn = row.querySelector(".use-btn");
    if (useBtn) {
      useBtn.addEventListener("click", async () => {
        await App.api(`/api/places/${place.id}/active`, { method: "POST" });
        App.toast(`Now cooking in ${place.label}`);
        this.render(body);
      });
    }
    row.querySelector(".del-btn").addEventListener("click", async () => {
      if (!confirm(`Remove ${place.label}?`)) return;
      await App.api(`/api/places/${place.id}`, { method: "DELETE" });
      this.render(body);
    });
    return row;
  },

  _routineRow(routine, body) {
    const when = routine.weekday
      ? `every ${routine.weekday}` : "every day";
    const row = App.el(`<div class="item-row">
      <span class="name">${_esc(routine.name)}</span>
      <span class="meta">${when} · ${_esc(routine.meal)} · since ${_esc(routine.start_date || "")}</span>
      <button class="icon-btn del-btn" title="Stop repeating">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    </div>`);
    row.querySelector(".del-btn").addEventListener("click", async () => {
      await App.api(`/api/routines/${routine.id}`, { method: "DELETE" });
      App.toast("Stopped repeating");
      this.render(body);
    });
    return row;
  },

  _ingredientRow(ing) {
    const n = ing.manual_nutrients;
    const nutritionText = ing.fdc_id
      ? `USDA · ${_esc(ing.fdc_description || `id ${ing.fdc_id}`)}`
      : (n ? `${n.calories_kcal || 0} kcal/100g` : "nutrition unknown");
    const list = ing.shop_list === "market" ? "farmer's market" : "groceries";
    const row = App.el(`<div class="item-row">
      <span class="name">${_esc(ing.name)}</span>
      <span class="meta">${ing.category} · ${list} · ${nutritionText}</span>
      <button class="icon-btn edit-btn" title="Edit">${App.icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>
    </div>`);
    row.querySelector(".edit-btn").addEventListener("click", () => this._openIngredientModal(ing));
    return row;
  },

  _openIngredientModal(ing) {
    const n = ing.manual_nutrients || {};
    App.openModal(`
      <h2>${_esc(ing.name)}
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <div class="modal-section" style="border-top:none;padding-top:0;">
        <label class="field-label">Category</label>
        <select id="if-category">
          ${CATEGORIES.map(c => `<option value="${c}" ${c === ing.category ? "selected" : ""}>${c}</option>`).join("")}
        </select>
        <label class="field-label" style="margin-top:6px;">Default unit</label>
        <input id="if-unit" value="${_esc(ing.default_unit)}" style="width:100px;">
        <label class="field-label" style="margin-top:6px;">Shopping list</label>
        <div class="seg seg-mini" id="if-list">
          <button data-list="grocery" class="${ing.shop_list !== "market" ? "active" : ""}">Groceries</button>
          <button data-list="market" class="${ing.shop_list === "market" ? "active" : ""}">Farmer's market</button>
        </div>
      </div>
      <div class="modal-section">
        <label class="field-label">USDA FoodData Central</label>
        ${ing.fdc_id
          ? `<div class="modal-hint">Bound to FDC id ${ing.fdc_id} — real nutrition data is used automatically.</div>`
          : `<div style="display:flex;gap:6px;">
               <input id="if-fdc-q" placeholder="search e.g. eggplant, raw" value="${_esc(ing.name)}" style="flex:1;">
               <button class="btn-ghost" id="if-fdc-search">Search</button>
             </div>
             <div id="if-fdc-results" style="display:flex;flex-direction:column;gap:4px;"></div>`}
      </div>
      <div class="modal-section">
        <label class="field-label">Nutrition per 100g (optional, until bound to USDA)</label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div><label class="field-label">Calories</label><input id="if-cal" type="number" value="${n.calories_kcal || ""}"></div>
          <div><label class="field-label">Protein g</label><input id="if-protein" type="number" value="${n.protein_g || ""}"></div>
          <div><label class="field-label">Fiber g</label><input id="if-fiber" type="number" value="${n.fiber_g || ""}"></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" id="if-save">Save</button>
      </div>
    `);

    const searchBtn = document.getElementById("if-fdc-search");
    if (searchBtn) {
      searchBtn.addEventListener("click", async () => {
        const resultsEl = document.getElementById("if-fdc-results");
        const q = document.getElementById("if-fdc-q").value.trim();
        if (!q) return;
        resultsEl.innerHTML = `<div class="modal-hint">Searching…</div>`;
        try {
          const res = await App.api(`/api/ingredients/fdc-search?q=${encodeURIComponent(q)}`);
          if (res.results.length === 0) {
            resultsEl.innerHTML = `<div class="modal-hint">No matches.</div>`;
            return;
          }
          resultsEl.innerHTML = "";
          res.results.forEach(r => {
            const row = App.el(`<button class="btn-ghost" style="text-align:left;justify-content:flex-start;">${_esc(r.description)}</button>`);
            row.addEventListener("click", async () => {
              const updated = await App.api(`/api/ingredients/${ing.id}`, { method: "PUT", body: { fdc_id: r.fdc_id } });
              const idx = this._ingredients.findIndex(i => i.id === ing.id);
              this._ingredients[idx] = updated.ingredient;
              App.closeModal();
              this._draw(document.getElementById("body"));
              App.toast(`Bound to "${r.description}"`);
            });
            resultsEl.appendChild(row);
          });
        } catch (e) {
          resultsEl.innerHTML = `<div class="modal-hint">${_esc(e.message)}</div>`;
        }
      });
    }

    document.getElementById("if-list").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      document.querySelectorAll("#if-list button").forEach(b => b.classList.toggle("active", b === btn));
    });

    document.getElementById("if-save").addEventListener("click", async () => {
      const category = document.getElementById("if-category").value;
      const shop_list = document.querySelector("#if-list button.active").dataset.list;
      const default_unit = document.getElementById("if-unit").value.trim() || "g";
      const cal = document.getElementById("if-cal").value;
      const protein = document.getElementById("if-protein").value;
      const fiber = document.getElementById("if-fiber").value;
      const manual_nutrients = (cal || protein || fiber)
        ? { calories_kcal: Number(cal) || 0, protein_g: Number(protein) || 0, fiber_g: Number(fiber) || 0, vitamins: {} }
        : null;
      const res = await App.api(`/api/ingredients/${ing.id}`, { method: "PUT", body: { category, default_unit, manual_nutrients, shop_list } });
      const idx = this._ingredients.findIndex(i => i.id === ing.id);
      this._ingredients[idx] = res.ingredient;
      App.closeModal();
      this._draw(document.getElementById("body"));
      App.toast("Ingredient updated");
    });
  },

  _memberRow(m) {
    const row = App.el(`<div class="item-row">
      <span class="name">${_esc(m.name)}</span>
      <span class="meta">${m.targets.calories_kcal} kcal · ${m.targets.protein_g}g protein · ${m.targets.fiber_g}g fiber${m.active ? "" : " · inactive"}</span>
      <button class="icon-btn edit-btn" title="Edit">${App.icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>
      <button class="icon-btn del-btn" title="Remove">${App.icon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>')}</button>
    </div>`);
    row.querySelector(".edit-btn").addEventListener("click", () => this._openMemberModal(m));
    row.querySelector(".del-btn").addEventListener("click", async () => {
      if (!confirm(`Remove ${m.name}?`)) return;
      const res = await App.api(`/api/household/members/${m.id}`, { method: "DELETE" });
      this._members = res.members;
      this._draw(document.getElementById("body"));
      App.toast(`Removed ${m.name}`);
    });
    return row;
  },

  _openMemberModal(member) {
    const t = member ? member.targets : { calories_kcal: 2000, protein_g: 50, fiber_g: 28, vitamins: {} };
    App.openModal(`
      <h2>${member ? "Edit member" : "Add household member"}
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <div class="modal-section" style="border-top:none;padding-top:0;">
        <label class="field-label">Name</label>
        <input id="mf-name" value="${member ? _esc(member.name) : ""}" placeholder="e.g. Storm">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:6px;">
          <div><label class="field-label">Calories/day</label><input id="mf-cal" type="number" value="${t.calories_kcal}"></div>
          <div><label class="field-label">Protein g/day</label><input id="mf-protein" type="number" value="${t.protein_g}"></div>
          <div><label class="field-label">Fiber g/day</label><input id="mf-fiber" type="number" value="${t.fiber_g}"></div>
        </div>
        ${member ? `<label class="check" style="margin-top:8px;"><input type="checkbox" id="mf-active" ${member.active ? "checked" : ""}><span class="box">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span>Active</label>` : ""}
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" id="mf-save">Save</button>
      </div>
    `);
    document.getElementById("mf-save").addEventListener("click", async () => {
      const name = document.getElementById("mf-name").value.trim();
      if (!name) { App.toast("Name is required"); return; }
      const targets = {
        calories_kcal: Number(document.getElementById("mf-cal").value) || 0,
        protein_g: Number(document.getElementById("mf-protein").value) || 0,
        fiber_g: Number(document.getElementById("mf-fiber").value) || 0,
        vitamins: t.vitamins || {},
      };
      let res;
      if (member) {
        const active = document.getElementById("mf-active").checked;
        res = await App.api(`/api/household/members/${member.id}`, { method: "PUT", body: { name, targets, active } });
      } else {
        res = await App.api("/api/household/members", { method: "POST", body: { name, targets } });
      }
      this._members = res.members;
      App.closeModal();
      this._draw(document.getElementById("body"));
      App.toast(member ? "Member updated" : "Member added");
    });
  },
};

function _esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
window._esc = _esc;
