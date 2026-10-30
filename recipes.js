/* Recipe list/editor. Ingredient rows resolve by name against the local
 * catalog (a <datalist>); typing a name that doesn't exist yet creates a
 * plain "other" category ingredient on save so a recipe never blocks on
 * ingredient bookkeeping -- categories/units/manual nutrients get refined
 * later from Settings' Ingredients list. FDC binding (Phase 3) hangs off
 * the same ingredient records without touching this flow. */
window.App = window.App || {};

const RC_NOTE = '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/>';
const RC_LIST = '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>';

App.recipes = {
  _recipes: [],
  _onDone: null,
  _ingredients: [],

  async render(body) {
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    const [recipesRes, ingredientsRes] = await Promise.all([
      App.api("/api/recipes"),
      App.api("/api/ingredients"),
    ]);
    this._recipes = recipesRes.recipes;
    this._ingredients = ingredientsRes.ingredients;
    this._draw(body);
  },

  _draw(body) {
    body.innerHTML = `
      <div class="board-toolbar">
        <div class="field-label" style="flex:1;">Recipes</div>
        <button class="icon-btn" id="import-recipe-btn" title="From a note">${App.icon(RC_NOTE)}</button>
        <button class="btn-primary" id="new-recipe-btn">+ New recipe</button>
      </div>
      <div class="pad" id="recipe-list" style="display:flex;flex-direction:column;gap:8px;"></div>
    `;
    const list = body.querySelector("#recipe-list");
    if (this._recipes.length === 0) {
      list.innerHTML = `<div class="empty-state">${App.icon('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>')}<div>No recipes yet. Add one to start building your week.</div></div>`;
    } else {
      this._recipes.forEach(r => list.appendChild(this._recipeRow(r)));
    }
    body.querySelector("#new-recipe-btn").addEventListener("click", () => this._openEditor(null));
    body.querySelector("#import-recipe-btn").addEventListener("click", () => this._openImport());
  },

  /* A recipe shared in from the Recipes app (or its inbox on the laptop): read like a note, the
   * ingredients resolved by name, saved to the recipe list -- type its name in a meal to use it. */
  async importShared(text) {
    const parsed = await App.api("/api/recipes/parse", { method: "POST", body: { text } });
    if (!parsed.name) { App.toast("Nothing to read in that recipe"); return false; }
    // never overwrite or duplicate: a recipe already here (same name, or same source page even after
    // you renamed it) keeps whatever you edited -- the Recipes app only ever adds
    const link = (text.match(/https?:\/\/\S+/g) || []).pop() || "";
    const norm = (u) => (u || "").trim().toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
    const have = (await App.api("/api/recipes")).recipes.some(x =>
      x.name.trim().toLowerCase() === parsed.name.trim().toLowerCase() || (link && norm(x.source_url) === norm(link)));
    if (have) return true;                                   // already saved: just clear the inbox file
    await this._saveParsed(parsed, ["shared"], link);
    App.toast(`Added “${parsed.name}” — type its name in a meal`);
    return true;
  },

  // A parsed recipe straight into the list: ingredients resolved by name, no editor step.
  async _saveParsed(parsed, tags, source_url = "") {
    const ings = (await App.api("/api/ingredients")).ingredients;
    const rows = [];
    for (const it of parsed.ingredients) {
      const unit = it.unit || "each";
      const ingredient_id = await App.resolveIngredientId(it.name, unit, ings, true);
      rows.push({ ingredient_id, qty: it.qty || 0, unit, note: it.note || "" });
    }
    await App.api("/api/recipes", { method: "POST", body: { name: parsed.name, servings: 4, ingredients: rows, tags, notes: parsed.notes || "", source_url } });
  },

  _recipeRow(r) {
    const n = r.nutrition_per_serving;
    const known = r.unknown_ingredients.length === 0 && r.ingredients.length > 0;
    const nutritionText = r.ingredients.length === 0
      ? "no ingredients yet"
      : known
        ? `${Math.round(n.calories_kcal)} kcal · ${n.protein_g.toFixed(1)}g protein · ${n.fiber_g.toFixed(1)}g fiber <span class="dim">/ serving</span>`
        : `nutrition unknown for ${r.unknown_ingredients.length} ingredient${r.unknown_ingredients.length === 1 ? "" : "s"}`;
    const row = App.el(`<div class="item-row" style="align-items:flex-start;">
      <div style="flex:1;min-width:0;">
        <div class="name">${_esc(r.name)}</div>
        <div class="meta" style="white-space:normal;">${r.servings} serving${r.servings === 1 ? "" : "s"} · ${nutritionText}</div>
      </div>
      <button class="icon-btn edit-btn" title="Edit">${App.icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>
      <button class="icon-btn del-btn" title="Delete">${App.icon('<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>')}</button>
    </div>`);
    row.querySelector(".edit-btn").addEventListener("click", () => this._openEditor(r));
    row.querySelector(".del-btn").addEventListener("click", async () => {
      if (!confirm(`Delete "${r.name}"?`)) return;
      await App.api(`/api/recipes/${r.id}`, { method: "DELETE" });
      App.toast("Recipe deleted");
      this.render(document.getElementById("body"));
    });
    return row;
  },

  async _resolveIngredientId(name, unit) {
    return App.resolveIngredientId(name, unit, this._ingredients, true);   // USDA match follows in the background
  },

  // `item` is a saved line ({ingredient_id, qty, unit}) or an imported one
  // ({name, qty, unit, note}) -- an import's missing amount/unit stays blank.
  _ingredientRow(item) {
    const name = item ? (item.name || _ingName(this._ingredients, item.ingredient_id)) : "";
    const qty = item && item.qty ? item.qty : "";
    const unit = item ? (item.unit || "") : "g";
    const row = App.el(`<div class="rf-ing-row" style="display:flex;gap:6px;align-items:center;">
      <input class="ing-name" placeholder="ingredient" autocomplete="off" spellcheck="false" value="${_esc(name)}" style="flex:2;min-width:0;">
      <input class="ing-qty" type="number" step="any" placeholder="qty" value="${qty}" style="width:70px;min-width:0;">
      <input class="ing-unit" placeholder="unit" value="${_esc(unit)}" style="width:90px;min-width:0;">
      <button class="icon-btn ing-remove" title="Remove">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    </div>`);
    row.querySelector(".ing-remove").addEventListener("click", () => row.remove());
    row.dataset.note = (item && item.note) || "";
    // Enter walks the line like a meal block: name → amount → a new line below (keyboard stays up)
    // the same ranked dropdown as a meal's lines; Enter finishes a started name ("ban" -> banana)
    App.ingSuggest.attach(row.querySelector(".ing-name"), {
      minChars: 1,
      context: () => ({ meal_name: (document.getElementById("rf-name") || {}).value || "" }),
      onPick: (item) => { if (item.typical) row.querySelector(".ing-qty").placeholder = item.typical.label; },
    });
    row.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      if (e.target.classList.contains("ing-name")) {
        App.ingSuggest.takeActive(e.target);
        row.querySelector(".ing-qty").focus();
        return;
      }
      const next = this._ingredientRow(null);
      next.querySelector(".ing-unit").value = "";
      row.after(next);
      next.querySelector(".ing-name").focus();
    });
    row.querySelectorAll("input").forEach(i => i.setAttribute("enterkeyhint", "enter"));
    return row;
  },

  /* A recipe from the Notes app: pick a note (recipe-looking ones first, or
   * search), or paste the text. recipe_import.py reads it -- top line = the
   * name, a line each = the ingredients, a leading amount = the quantity --
   * and the editor opens filled in, to check and save. */
  /* Opened from the plan's top bar so importing never leaves the week: `onDone` runs instead of
   * redrawing the Recipes page. */
  async openImportFrom(onDone) {
    this._onDone = onDone;
    if (!this._recipes.length) {
      try { this._recipes = (await App.api("/api/recipes")).recipes; } catch (e) { /* only the duplicate check */ }
    }
    this._openImport();
  },

  _finish() {
    const f = this._onDone;
    this._onDone = null;
    if (f) f(); else this.render(document.getElementById("body"));
  },

  _openImport() {
    App.openModal(`
      <h2>From notes
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <div class="modal-section" style="border-top:none;padding-top:0;">
        <input id="ri-q" placeholder="Search notes…" spellcheck="false" autocomplete="off">
        <div id="ri-list" class="ri-list"><div class="loading-state"><div class="spin"></div>Reading notes…</div></div>
        <div class="ri-bar" id="ri-bar" hidden>
          <span class="dim num" id="ri-count"></span>
          <button class="icon-btn" id="ri-review" title="Review first">${App.icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>
          <button class="btn-primary" id="ri-add">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</button>
        </div>
      </div>
      <div class="modal-section">
        <textarea id="ri-paste" rows="4" placeholder="…or paste a recipe: name on top, one ingredient a line"></textarea>
        <button class="btn-primary" id="ri-paste-go" style="align-self:flex-end;">Read it</button>
      </div>
    `);
    const list = document.getElementById("ri-list");
    const open = (parsed) => {
      if (!parsed.ingredients.length && !parsed.name) { App.toast("Nothing to read in that"); return; }
      App.closeModal();
      this._openEditor(null, parsed);
    };
    const picked = new Map();   // note id → title, kept across searches
    const bar = () => {
      document.getElementById("ri-bar").hidden = picked.size === 0;
      document.getElementById("ri-count").textContent = `${picked.size} selected`;
      document.getElementById("ri-review").hidden = picked.size !== 1;
    };
    // one tap adds every picked note as a recipe; a single pick can be reviewed in the editor first
    document.getElementById("ri-review").addEventListener("click", async () => {
      const [id] = picked.keys();
      open(await App.api(`/api/notes/${encodeURIComponent(id)}/recipe`));
    });
    document.getElementById("ri-add").addEventListener("click", async (e) => {
      e.currentTarget.disabled = true;
      const have = new Set(this._recipes.map(r => r.name.trim().toLowerCase()));
      let added = 0, skipped = [];
      for (const [id, title] of picked) {
        const parsed = await App.api(`/api/notes/${encodeURIComponent(id)}/recipe`);
        if (!parsed.name || !parsed.ingredients.length) { skipped.push(title); continue; }
        if (have.has(parsed.name.trim().toLowerCase())) { skipped.push(`${parsed.name} (already saved)`); continue; }
        await this._saveParsed(parsed, ["note"]);
        have.add(parsed.name.trim().toLowerCase());
        added++;
      }
      App.closeModal();
      App.toast(`Added ${added} recipe${added === 1 ? "" : "s"}` + (skipped.length ? ` · skipped ${skipped.join(", ")}` : ""));
      this._finish();
    });
    let seq = 0;
    const load = async (q) => {
      const mine = ++seq;
      let res;
      try { res = await App.api(`/api/notes?q=${encodeURIComponent(q)}`); }
      catch (e) { if (mine === seq) list.innerHTML = `<div class="gp-empty">Couldn't reach the notes</div>`; return; }
      if (mine !== seq) return;
      if (!res.available) { list.innerHTML = `<div class="gp-empty">No notes on this device — paste instead</div>`; return; }
      list.innerHTML = res.notes.length ? "" : `<div class="gp-empty">${q ? "No note matches" : "No recipe-looking notes — search for one"}</div>`;
      res.notes.forEach(n => {
        const row = App.el(`<button class="ri-note${picked.has(n.id) ? " sel" : ""}">
          <span class="ri-tick">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</span>
          <span class="ri-note-t">${_esc(n.title)}</span>
          <span class="dim num">${n.lines ? `${n.lines} ${App.icon(RC_LIST)}` : ""}</span>
        </button>`);
        row.addEventListener("click", () => {
          if (picked.has(n.id)) picked.delete(n.id); else picked.set(n.id, n.title);
          row.classList.toggle("sel", picked.has(n.id));
          bar();
        });
        list.appendChild(row);
      });
    };
    let timer = null;
    document.getElementById("ri-q").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => load(e.target.value.trim()), 250);
    });
    document.getElementById("ri-paste-go").addEventListener("click", async () => {
      const text = document.getElementById("ri-paste").value;
      if (!text.trim()) return;
      open(await App.api("/api/recipes/parse", { method: "POST", body: { text } }));
    });
    load("");
  },

  _openEditor(recipe, imported) {
    App.openModal(`
      <h2>${recipe ? "Edit recipe" : "New recipe"}
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <div class="modal-section" style="border-top:none;padding-top:0;">
        <label class="field-label">Name</label>
        <input id="rf-name" value="${recipe ? _esc(recipe.name) : imported ? _esc(imported.name) : ""}" placeholder="e.g. Eggplant Parm">
        <label class="field-label" style="margin-top:6px;">Servings</label>
        <input id="rf-servings" type="number" min="1" value="${recipe ? recipe.servings : 4}" style="width:80px;">
      </div>
      <div class="modal-section">
        <label class="field-label">Ingredients</label>
        <div id="rf-ingredients" style="display:flex;flex-direction:column;gap:6px;"></div>
        <button class="btn-ghost" id="rf-add-ing" style="align-self:flex-start;">+ Add ingredient</button>
      </div>
      <div class="modal-section">
        <label class="field-label">Tags (comma separated)</label>
        <input id="rf-tags" value="${recipe ? _esc((recipe.tags || []).join(", ")) : ""}">
        <label class="field-label" style="margin-top:6px;">Notes</label>
        <textarea id="rf-notes" rows="2">${recipe ? _esc(recipe.notes || "") : imported ? _esc(imported.notes || "") : ""}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" id="rf-save">Save</button>
      </div>
    `);

    const ingWrap = document.getElementById("rf-ingredients");
    const lines = recipe ? recipe.ingredients : imported ? imported.ingredients : [];
    const rows = lines.length ? lines.map(it => this._ingredientRow(it)) : [this._ingredientRow(null)];
    rows.forEach(r => ingWrap.appendChild(r));

    document.getElementById("rf-add-ing").addEventListener("click", () => {
      ingWrap.appendChild(this._ingredientRow(null));
    });

    document.getElementById("rf-save").addEventListener("click", async () => {
      const name = document.getElementById("rf-name").value.trim();
      if (!name) { App.toast("Name is required"); return; }
      const servings = Number(document.getElementById("rf-servings").value) || 1;
      const tags = document.getElementById("rf-tags").value.split(",").map(t => t.trim()).filter(Boolean);
      const notes = document.getElementById("rf-notes").value;

      const ingredientRows = Array.from(ingWrap.children);
      const ingredients = [];
      for (const row of ingredientRows) {
        const iname = row.querySelector(".ing-name").value.trim();
        const qty = Number(row.querySelector(".ing-qty").value) || 0;
        // no unit written: a count ("2 eggs" = 2 of them, weighed by USDA's
        // per-piece portion), never a silent 2 g. No amount at all is fine too.
        const unit = row.querySelector(".ing-unit").value.trim() || "each";
        if (!iname) continue;
        const ingredient_id = await this._resolveIngredientId(iname, unit);
        ingredients.push({ ingredient_id, qty, unit, note: row.dataset.note || "" });
      }

      const body = { name, servings, ingredients, tags, notes };
      if (recipe) {
        await App.api(`/api/recipes/${recipe.id}`, { method: "PUT", body });
      } else {
        await App.api("/api/recipes", { method: "POST", body });
      }
      App.closeModal();
      App.toast(recipe ? "Recipe updated" : "Recipe added");
      this._finish();
    });
  },
};

function _ingName(list, id) {
  const found = list.find(i => i.id === id);
  return found ? found.name : "";
}
