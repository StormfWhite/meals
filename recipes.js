/* Recipe list/editor. Ingredient rows resolve by name against the local
 * catalog (a <datalist>); typing a name that doesn't exist yet creates a
 * plain "other" category ingredient on save so a recipe never blocks on
 * ingredient bookkeeping -- categories/units/manual nutrients get refined
 * later from Settings' Ingredients list. FDC binding (Phase 3) hangs off
 * the same ingredient records without touching this flow. */
window.App = window.App || {};

App.recipes = {
  _recipes: [],
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
    return App.resolveIngredientId(name, unit, this._ingredients);
  },

  _ingredientRow(item) {
    const row = App.el(`<div style="display:flex;gap:6px;align-items:center;">
      <input class="ing-name" list="ingredient-options" placeholder="ingredient" value="${item ? _esc(_ingName(this._ingredients, item.ingredient_id)) : ""}" style="flex:2;">
      <input class="ing-qty" type="number" step="any" placeholder="qty" value="${item ? item.qty : ""}" style="width:70px;">
      <input class="ing-unit" placeholder="unit (g, medium, cup...)" value="${item ? _esc(item.unit) : "g"}" style="width:120px;">
      <button class="icon-btn ing-remove" title="Remove">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
    </div>`);
    row.querySelector(".ing-remove").addEventListener("click", () => row.remove());
    return row;
  },

  _openEditor(recipe) {
    App.openModal(`
      <h2>${recipe ? "Edit recipe" : "New recipe"}
        <button class="icon-btn" onclick="App.closeModal()">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
      </h2>
      <datalist id="ingredient-options">
        ${this._ingredients.map(i => `<option value="${_esc(i.name)}">`).join("")}
      </datalist>
      <div class="modal-section" style="border-top:none;padding-top:0;">
        <label class="field-label">Name</label>
        <input id="rf-name" value="${recipe ? _esc(recipe.name) : ""}" placeholder="e.g. Eggplant Parm">
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
        <textarea id="rf-notes" rows="2">${recipe ? _esc(recipe.notes || "") : ""}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="App.closeModal()">Cancel</button>
        <button class="btn-primary" id="rf-save">Save</button>
      </div>
    `);

    const ingWrap = document.getElementById("rf-ingredients");
    const rows = recipe && recipe.ingredients.length
      ? recipe.ingredients.map(it => this._ingredientRow(it))
      : [this._ingredientRow(null)];
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
        const qty = Number(row.querySelector(".ing-qty").value);
        const unit = row.querySelector(".ing-unit").value.trim() || "g";
        if (!iname || !qty) continue;
        const ingredient_id = await this._resolveIngredientId(iname, unit);
        ingredients.push({ ingredient_id, qty, unit });
      }

      const body = { name, servings, ingredients, tags, notes };
      if (recipe) {
        await App.api(`/api/recipes/${recipe.id}`, { method: "PUT", body });
      } else {
        await App.api("/api/recipes", { method: "POST", body });
      }
      App.closeModal();
      App.toast(recipe ? "Recipe updated" : "Recipe added");
      this.render(document.getElementById("body"));
    });
  },
};

function _ingName(list, id) {
  const found = list.find(i => i.id === id);
  return found ? found.name : "";
}
