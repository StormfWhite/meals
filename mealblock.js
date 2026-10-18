/* One meal on the plan: a name line (with a dropdown of past meals at that
 * slot) and under it one small line per ingredient — amount on the left,
 * a note column that stays tiny until you type in it, and that line's
 * stats on the right. A running total sits in the meal's header.
 *
 * There is no Save button and no modal. A block persists itself on
 * `change` (blur / Enter / picking from the dropdown), which is also the
 * only moment it's allowed to mint a new ingredient — committing on every
 * keystroke would create an ingredient called "chick" on the way to
 * "chicken". Live stats are the opposite: they refresh on `input`,
 * debounced, and simply skip any row whose name isn't in the catalog yet,
 * so nothing is written to disk just to show a number.
 *
 * The block never redraws itself after a commit (that would eat the
 * caret mid-edit) — it patches its own header/stats and hands the updated
 * week back to the host, which owns the day and week rollups.
 */
window.App = window.App || {};

const MB_LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
const MB_ICONS = {
  breakfast: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 1v3M10 1v3M14 1v3"/>',
  lunch: '<path d="M11 2v20"/><path d="M18 2v9a4 4 0 0 1-8 0V2"/><path d="M18 2v20"/><path d="M6 2v6a3 3 0 0 0 3 3"/><path d="M6 2v20"/>',
  dinner: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
};
const MB_STAR = '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9Z"/>';
const MB_REPEAT = '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>';
const MB_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

App.mealBlock = {
  create(host, date, meal, index = 0) {
    // Index 0 keeps the original key form -- see board.py's parse_slot_key.
    const key = index ? `${date}:${meal}~${index}` : `${date}:${meal}`;
    let matchedRecipe = null;
    let ownRecipe = false;   // this block minted the recipe, so edits belong to the recipe itself
    let dirty = false;
    let previewTimer = null;
    let totals = null;

    const el = App.el(`
      <section class="mb" data-meal="${meal}" data-key="${App.esc(key)}">
        <header class="mb-head">
          ${index ? '<span class="mb-also" title="A second meal at this slot">+</span>' : App.icon(MB_ICONS[meal])}
          <span class="mb-label">${index ? "Also" : MB_LABELS[meal]}</span>
          <span class="mb-total num"></span>
        </header>
        <div class="mb-name-row">
          <input class="mb-name" autocomplete="off" placeholder="${MB_LABELS[meal]}…" spellcheck="false">
          <input class="mb-serv num" type="number" min="0.5" step="0.5" title="Servings used from the batch" value="1">
          <button class="icon-btn mb-banger" title="Add to Bangers">${App.icon(MB_STAR)}</button>
          <button class="icon-btn mb-repeat" title="Repeat this meal every week">${App.icon(MB_REPEAT)}</button>
          <button class="icon-btn mb-clear" title="Clear this meal">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>
        <div class="mb-link"></div>
        <div class="mb-rows"></div>
      </section>
    `);

    const nameInput = el.querySelector(".mb-name");
    // Meal-name dropdown: learned order, with a x per row that retires a
    // suggestion (the recipe and its history stay; it just stops being offered).
    App.ingSuggest.attach(nameInput, {
      local: () => host.optionsFor(meal).slice(),
      onDelete: (item) => host.hideOption(meal, item),
    });
    const servInput = el.querySelector(".mb-serv");
    const rowsWrap = el.querySelector(".mb-rows");
    const linkWrap = el.querySelector(".mb-link");
    const totalEl = el.querySelector(".mb-total");

    // ── reading the DOM ──────────────────────────────────────────────
    const slot = () => host.getWeek().slots[key] || null;

    const recipeByName = (name) => {
      const t = (name || "").trim().toLowerCase();
      if (!t) return null;
      const opt = host.optionsFor(meal).find(o => o.name.toLowerCase() === t);
      const byOption = opt ? host.recipes.find(r => r.id === opt.recipe_id) : null;
      return byOption || host.recipes.find(r => r.name.toLowerCase() === t) || null;
    };

    const ingredientByName = (name) => {
      const t = (name || "").trim().toLowerCase();
      if (!t) return null;
      return host.ingredients.find(i => i.name.toLowerCase() === t) || null;
    };

    const readRows = () => Array.from(rowsWrap.children).map(row => ({
      el: row,
      name: row.querySelector(".mb-ing").value.trim(),
      amount: row.querySelector(".mb-amt").value.trim(),
      note: row.querySelector(".mb-note").value.trim(),
    })).filter(r => r.name || r.amount || r.note);

    // Rows the stats endpoint can actually price: a known ingredient and a
    // real quantity. `applyPreview` walks the DOM with this exact same
    // filter — if the two ever drift, every row's stat shifts by one.
    const priceable = (r) => {
      const ing = ingredientByName(r.name);
      if (!ing) return null;
      const amt = _mbParseAmount(r.amount);
      if (!amt || !amt.qty) return null;
      return { ingredient_id: ing.id, qty: amt.qty, unit: amt.unit || ing.default_unit || "g" };
    };

    const knownRows = () => readRows().map(priceable).filter(Boolean);

    /* Which list this line will be bought on. Everything typed here ends
     * up on one of the two, so the line says which one rather than making
     * you go and look: a coloured edge, no width spent, with the reason in
     * the tooltip. Unknown until the ingredient is in the catalog. */
    const markDestination = (row) => {
      const ing = ingredientByName(row.querySelector(".mb-ing").value);
      const dest = ing ? ing.shop_list : null;
      row.classList.toggle("to-market", dest === "market");
      row.classList.toggle("to-grocery", dest === "grocery");
      row.title = dest === "market" ? "goes on the farmer's market list"
        : dest === "grocery" ? "goes on the grocery list" : "";
    };

    // ── drawing ──────────────────────────────────────────────────────
    const makeRow = (item) => {
      const ing = item ? host.ingredients.find(i => i.id === item.ingredient_id) : null;
      const row = App.el(`
        <div class="mb-row">
          <input class="mb-ing" placeholder="ingredient" spellcheck="false" autocomplete="off" value="${item ? App.esc(ing ? ing.name : "") : ""}">
          <input class="mb-amt num" placeholder="amt" value="${item ? App.esc(_mbFormatAmount(item.qty, item.unit)) : ""}">
          <input class="mb-note ${item && item.note ? "has-note" : ""}" placeholder="…" title="Note" value="${item ? App.esc(item.note || "") : ""}">
          <span class="mb-stat num"></span>
          <button class="icon-btn mb-row-x" title="Remove line" tabindex="-1">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>
      `);
      const note = row.querySelector(".mb-note");
      note.addEventListener("input", () => note.classList.toggle("has-note", note.value.trim() !== ""));
      markDestination(row);
      row.querySelector(".mb-ing").addEventListener("change", () => markDestination(row));
      const removeRow = () => {
        row.remove();
        ensureBlankRow();
        markDirty();
        commit();
      };
      row.querySelector(".mb-row-x").addEventListener("click", removeRow);
      // on a phone: swipe the line away (the ✕ is hover-only); the blank line at the end stays put
      App.swipeAway(row, removeRow, { wrap: false, can: () => row.querySelector(".mb-ing").value.trim() !== "" });
      row.addEventListener("keydown", (e) => onRowKey(e, row));

      // The learned dropdown: ranked by what actually gets cooked, told
      // which meal this is and what's already on the block so it can offer
      // the thing that usually comes next (see suggest.py).
      App.ingSuggest.attach(row.querySelector(".mb-ing"), {
        context: () => ({
          meal,
          meal_name: nameInput.value.trim(),
          week: host.listWeek(),
          used: readRows()
            .filter(r => r.el !== row)
            .map(r => { const k = ingredientByName(r.name); return k ? k.id : null; })
            .filter(Boolean),
        }),
        onPick: (item) => {
          // The usual amount is shown, never filled in -- a quantity nobody
          // typed must not reach the plan or the grocery list.
          const amt = row.querySelector(".mb-amt");
          amt.placeholder = item.typical ? item.typical.label : "amt";
        },
      });
      return row;
    };

    // ── keyboard: walking a meal's lines ─────────────────────────────
    /* Tab is how a list gets written: name, amount, and off the end of a
     * line into a fresh one below. Tab on a line that's still empty means
     * "done here" and moves to the next meal, so a whole day can be typed
     * without reaching for the mouse. Enter does the same thing as Tab;
     * Escape (once the suggestion menu is gone) drops out of the block.
     * The note column stays out of the walk on purpose -- it's optional,
     * and Tabbing through it every line would cost more than it saves. */
    const rowIsBlank = (row) => !["mb-ing", "mb-amt", "mb-note"]
      .some(cls => row.querySelector("." + cls).value.trim());

    const focusField = (row, sel) => {
      const el = row.querySelector(sel);
      if (!el) return;
      el.focus();
      if (sel === ".mb-amt") el.select();
    };

    const onRowKey = (e, row) => {
      if (e.key === "Escape") {
        e.stopPropagation();          // ending the line, not closing the grocery list
        e.target.blur();
        return;
      }
      if (e.key !== "Tab" && e.key !== "Enter") return;
      const onName = e.target.classList.contains("mb-ing");

      if (e.shiftKey) {
        if (e.key === "Enter") return;
        e.preventDefault();
        if (!onName) { focusField(row, ".mb-ing"); return; }
        const prev = row.previousElementSibling;
        if (prev) focusField(prev, ".mb-amt"); else nameInput.focus();
        return;
      }

      if (onName) {
        const pick = App.ingSuggest.active();
        if (pick) App.ingSuggest.accept(pick);
        App.ingSuggest.close();
      }
      e.preventDefault();
      if (rowIsBlank(row)) { host.focusNextMeal(key); return; }
      if (onName) { focusField(row, ".mb-amt"); return; }
      let next = row.nextElementSibling;
      if (!next) { next = makeRow(null); rowsWrap.appendChild(next); }
      focusField(next, ".mb-ing");
    };

    const ensureBlankRow = () => {
      const last = rowsWrap.lastElementChild;
      const lastIsBlank = last && !last.querySelector(".mb-ing").value.trim()
        && !last.querySelector(".mb-amt").value.trim() && !last.querySelector(".mb-note").value.trim();
      if (!lastIsBlank) rowsWrap.appendChild(makeRow(null));
    };

    const drawRows = (list) => {
      rowsWrap.innerHTML = "";
      (list || []).forEach(item => rowsWrap.appendChild(makeRow(item)));
      ensureBlankRow();
      schedulePreview();
    };

    /* "Every Monday" — the meal on screen becomes a rule, and every week
     * that hasn't been touched follows it (routines.py). The badge below
     * the name says when a meal is here because of a rule rather than
     * because someone planned it, since the two look identical otherwise. */
    const drawRepeat = () => {
      const s = slot();
      const btn = el.querySelector(".mb-repeat");
      const on = !!(s && s.from_routine);
      btn.classList.toggle("on", on);
      btn.title = on ? "Repeating — click to change" : "Repeat this meal every week";
      el.classList.toggle("from-routine", on);
    };

    const openRepeatMenu = async () => {
      const s = slot();
      if (!matchedRecipe) { App.toast("Name the meal first"); return; }
      const weekday = MB_WEEKDAYS[new Date(date + "T00:00:00").getDay()];
      const label = weekday.charAt(0).toUpperCase() + weekday.slice(1);
      const menu = App.el(`
        <div class="mb-menu">
          <button data-do="weekly">Every ${App.esc(label)} ${MB_LABELS[meal].toLowerCase()}</button>
          <button data-do="daily">Every day's ${MB_LABELS[meal].toLowerCase()}</button>
          ${s && s.from_routine ? '<button data-do="stop" class="danger">Stop repeating</button>' : ""}
          <button data-do="week">Fill the rest of this week</button>
        </div>
      `);
      document.body.appendChild(menu);
      const rect = el.querySelector(".mb-repeat").getBoundingClientRect();
      menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 150)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left - 120, window.innerWidth - 232))}px`;

      const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", away); } };
      setTimeout(() => document.addEventListener("mousedown", away), 0);

      menu.addEventListener("click", async (e) => {
        const action = e.target.closest("button") && e.target.closest("button").dataset.do;
        if (!action) return;
        menu.remove();
        document.removeEventListener("mousedown", away);
        try {
          if (action === "stop") {
            await App.api(`/api/routines/${s.from_routine}`, { method: "DELETE" });
            App.toast("Stopped repeating");
          } else if (action === "week") {
            await host.fillWeek(key, matchedRecipe.id, meal, Number(servInput.value) || 1);
            App.toast(`${matchedRecipe.name} across the week`);
            return;
          } else {
            await App.api("/api/routines", {
              method: "POST",
              body: {
                meal,
                recipe_id: matchedRecipe.id,
                weekday: action === "weekly" ? weekday : null,
                servings_used: Number(servInput.value) || 1,
                start_date: date,
              },
            });
            App.toast(action === "weekly" ? `Every ${label}` : "Every day");
          }
          await host.reloadWeek();
        } catch (err) { App.toast(err.message); }
      });
    };

    const drawLink = () => {
      linkWrap.innerHTML = "";
      const s = slot();
      if (!s) return;
      if (s.leftover_group) {
        linkWrap.innerHTML = `<span class="mb-tag">${App.icon('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>')}leftovers</span>`;
        return;
      }
      const other = Object.entries(host.getWeek().slots)
        .find(([k, o]) => k !== key && o.recipe_id === s.recipe_id && !o.leftover_group);
      if (!other) return;
      const [oDate, oMeal] = other[0].split(":");
      const btn = App.el(`<button class="mb-tag mb-link-btn">${App.icon('<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><path d="M8 12h8"/>')}same batch as ${_mbShortDay(oDate)} ${MB_LABELS[oMeal].toLowerCase()}</button>`);
      btn.addEventListener("click", async () => {
        const week = await App.api(`/api/board/${host.getWeek().week_start}/leftover-groups/link`, {
          method: "POST", body: { slot_a: key, slot_b: other[0] },
        });
        host.onWeekChanged(week);
        App.toast("Linked as leftovers");
      });
      linkWrap.appendChild(btn);
    };

    // The star is lit when this meal is already a banger for this meal type.
    const bangerFor = () => matchedRecipe && App.bangers.find(meal, matchedRecipe.id);
    const syncStar = () => {
      const b = bangerFor();
      starBtn.classList.toggle("on", !!b);
      starBtn.title = b ? "Remove from Bangers" : "Add to Bangers";
    };
    const starBtn = el.querySelector(".mb-banger");
    starBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      if (!nameInput.value.trim()) { App.toast("Name the meal first"); return; }
      await commit().catch(err => App.toast(err.message));   // makes the recipe if it's new
      if (!matchedRecipe) { App.toast("Name the meal first"); return; }
      const b = bangerFor();
      if (b) await App.bangers.remove(b.id); else await App.bangers.addRecipe(meal, matchedRecipe.id);
      syncStar();
    });
    document.addEventListener("bangers-changed", () => { if (el.isConnected) syncStar(); });

    const draw = () => {
      const s = slot();
      matchedRecipe = s ? host.recipes.find(r => r.id === s.recipe_id) || null : null;
      ownRecipe = false;
      nameInput.value = matchedRecipe ? matchedRecipe.name : "";
      nameInput.title = nameInput.value;
      servInput.value = s ? s.servings_used : 1;
      el.classList.toggle("filled", !!s);
      drawRows(s ? (s.ingredient_overrides || (matchedRecipe ? matchedRecipe.ingredients : [])) : null);
      drawLink();
      drawRepeat();
      syncStar();
    };

    // ── live stats ───────────────────────────────────────────────────
    const applyPreview = (preview) => {
      totals = preview ? preview.total : null;
      let i = 0;
      Array.from(rowsWrap.children).forEach(row => {
        const statEl = row.querySelector(".mb-stat");
        const r = {
          name: row.querySelector(".mb-ing").value.trim(),
          amount: row.querySelector(".mb-amt").value.trim(),
        };
        if (!preview || !priceable(r)) { statEl.textContent = ""; statEl.title = ""; return; }
        const pr = preview.rows[i++];
        statEl.textContent = pr ? _mbStat(pr, host.compact) : "";
        statEl.title = pr ? `${Math.round(pr.calories_kcal)} kcal · ${pr.protein_g.toFixed(1)} g protein · ${pr.fiber_g.toFixed(1)} g fiber` : "";
      });
      const kcal = totals ? Math.round(totals.calories_kcal) : 0;
      totalEl.textContent = kcal ? `${kcal} kcal · ${totals.protein_g.toFixed(0)}g P` : "";
      totalEl.title = totals ? `${kcal} kcal · ${totals.protein_g.toFixed(1)} g protein · ${totals.fiber_g.toFixed(1)} g fiber` : "";
    };

    const refreshStats = async () => {
      const rows = knownRows();
      if (rows.length === 0) { applyPreview(null); host.onStatsChanged(); return; }
      let preview;
      try { preview = await App.api("/api/nutrition/preview", { method: "POST", body: { rows } }); }
      catch (e) { return; }
      applyPreview(preview);
      host.onStatsChanged();
    };

    const schedulePreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(refreshStats, 250);
    };

    // ── persistence ──────────────────────────────────────────────────
    const markDirty = () => { dirty = true; };

    const commit = async () => {
      if (!dirty) return;
      dirty = false;
      const week = host.getWeek();
      const name = nameInput.value.trim();

      if (!name) {
        if (slot()) {
          const updated = await App.api(`/api/board/${week.week_start}/slots/${key}`, { method: "DELETE" });
          host.onWeekChanged(updated);
        }
        return;
      }

      const rows = [];
      for (const r of readRows()) {
        if (!r.name) continue;
        const amt = _mbParseAmount(r.amount);
        const known = ingredientByName(r.name);
        const unit = (amt && amt.unit) || (known && known.default_unit) || "g";
        const ingredient_id = await App.resolveIngredientId(r.name, unit, host.ingredients);
        rows.push({ ingredient_id, qty: amt ? amt.qty : 0, unit, note: r.note });
      }

      let recipe = recipeByName(name);
      if (!recipe) {
        const created = await App.api("/api/recipes", { method: "POST", body: { name, servings: 1, ingredients: rows } });
        host.recipes.push(created.recipe);
        recipe = created.recipe;
        ownRecipe = true;
      } else if (ownRecipe && recipe.id === (matchedRecipe && matchedRecipe.id)) {
        // A meal this block just invented: keep editing the recipe itself,
        // so reusing it next week autofills the ingredients instead of
        // finding an empty shell with everything hidden in an override.
        const updated = await App.api(`/api/recipes/${recipe.id}`, { method: "PUT", body: { ingredients: rows } });
        recipe = updated.recipe;
        const at = host.recipes.findIndex(r => r.id === recipe.id);
        if (at >= 0) host.recipes[at] = recipe;
      }
      matchedRecipe = recipe;

      let ingredient_overrides = null;
      if (!ownRecipe) {
        const base = (recipe.ingredients || []).map(i => ({ ingredient_id: i.ingredient_id, qty: i.qty, unit: i.unit, note: i.note || "" }));
        if (JSON.stringify(rows) !== JSON.stringify(base)) ingredient_overrides = rows;
      }

      const updated = await App.api(`/api/board/${week.week_start}/slots/${key}`, {
        method: "PUT",
        body: { recipe_id: recipe.id, servings_used: Number(servInput.value) || 1, ingredient_overrides },
      });
      host.onWeekChanged(updated);
      host.invalidateOptions(meal);
      el.classList.add("filled");
      drawLink();
      drawRepeat();
      // Ingredients minted by this commit now have a shopping list -- show
      // where each line is going without waiting for a redraw.
      Array.from(rowsWrap.children).forEach(markDestination);
    };

    // ── wiring ───────────────────────────────────────────────────────
    el.addEventListener("input", (e) => {
      markDirty();
      if (e.target.classList.contains("mb-ing") || e.target.classList.contains("mb-amt")) {
        if (e.target.closest(".mb-row") === rowsWrap.lastElementChild) ensureBlankRow();
        schedulePreview();
      }
      if (e.target === nameInput) {
        nameInput.title = nameInput.value;
        queueMicrotask(syncStar);
        const found = recipeByName(nameInput.value);
        if (found && (!matchedRecipe || found.id !== matchedRecipe.id)) {
          matchedRecipe = found;
          ownRecipe = false;
          drawRows(found.ingredients);   // picked a past meal — bring its lines along
        } else if (!found) {
          matchedRecipe = null;
        }
      }
    });

    el.addEventListener("change", () => { markDirty(); commit().catch(err => App.toast(err.message)); });

    el.querySelector(".mb-repeat").addEventListener("click", (e) => {
      e.preventDefault();
      openRepeatMenu();
    });

    el.querySelector(".mb-clear").addEventListener("click", async () => {
      nameInput.value = "";
      markDirty();
      await commit().catch(err => App.toast(err.message));
      matchedRecipe = null;
      ownRecipe = false;
      servInput.value = 1;
      el.classList.remove("filled");
      linkWrap.innerHTML = "";
      drawRows(null);
    });

    draw();

    return {
      el, date, meal, key,
      knownRows,
      applyPreview,
      refreshStats,
      redraw: draw,
      get totals() { return totals; },
      flush: () => commit().catch(() => {}),
    };
  },
};

/* "2", "2.5", "1/2", "2 1/2", each optionally followed by a unit word:
 * one field instead of a qty box plus a unit box, because a day column is
 * only so wide and "1 1/2 cups" is how a list actually gets written. */
function _mbParseAmount(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const m = t.match(/^(\d*\.?\d+)?\s*(?:(\d+)\s*\/\s*(\d+))?\s*([a-zA-Z][a-zA-Z.%-]*(?:\s+[a-zA-Z][a-zA-Z.%-]*)?)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  let qty = m[1] ? parseFloat(m[1]) : 0;
  if (m[2] && m[3] && Number(m[3])) qty += Number(m[2]) / Number(m[3]);
  return { qty, unit: (m[4] || "").trim() };
}

function _mbFormatAmount(qty, unit) {
  const n = Number(qty);
  const shown = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "";
  return unit && unit !== "g" ? `${shown} ${unit}` : (unit === "g" ? `${shown} g` : shown);
}

function _mbStat(row, compact) {
  const kcal = Math.round(row.calories_kcal);
  if (!kcal && !row.protein_g) return "";
  return compact ? String(kcal) : `${kcal} · ${row.protein_g.toFixed(0)}g`;
}

function _mbShortDay(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
}
