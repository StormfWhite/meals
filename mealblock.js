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
// where a recipe came from: an open book (a web page or a cookbook photo)
const MB_BOOK = '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2Z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7Z"/>';
const MB_LINK = '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>';
const MB_OPEN = '<path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>';
const MB_CAMERA = '<path d="M3 8a2 2 0 0 1 2-2h2l2-3h6l2 3h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="4"/>';
// whose meal: one person / everyone
const MB_PERSON = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
const MB_PEOPLE = '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a7 7 0 0 1 4 6.5"/>';
// making it in bulk: stacked containers
const MB_BULK = '<rect x="4" y="3" width="16" height="6" rx="1.5"/><rect x="4" y="11" width="16" height="4" rx="1.5"/><rect x="4" y="17" width="16" height="4" rx="1.5"/>';
const MB_FLAME = '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8a7 7 0 0 0 7 7Z"/>';
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
          <button class="mb-who" hidden></button>
          <span class="mb-total num"></span>
        </header>
        <div class="mb-name-row">
          <input class="mb-name" autocomplete="off" placeholder="${MB_LABELS[meal]}…" spellcheck="false">
          <input class="mb-serv num" type="number" min="0.5" step="0.5" title="Servings used from the batch" value="1">
          <button class="icon-btn mb-source" title="Recipe: a link or a cookbook photo">${App.icon(MB_BOOK)}</button>
          <button class="icon-btn mb-banger" title="Add to Bangers">${App.icon(MB_STAR)}</button>
          <button class="icon-btn mb-repeat" title="Repeat this meal every week">${App.icon(MB_REPEAT)}</button>
          <button class="icon-btn mb-clear" title="${index ? "Remove this meal" : "Clear this meal"}">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>
        </div>
        <div class="mb-link"></div>
        <div class="mb-rows"></div>
        <div class="mb-foot"></div>
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
    const footWrap = el.querySelector(".mb-foot");
    let sources = null;      // this slot's entry from /api/board/{week}/sources (stock.slot_sources)
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
      if (paintSource(row, ing)) return;
      const dest = ing ? ing.shop_list : null;
      row.classList.toggle("to-market", dest === "market");
      row.classList.toggle("to-grocery", dest === "grocery");
      row.title = dest === "market" ? "goes on the farmer's market list"
        : dest === "grocery" ? "goes on the grocery list" : "";
    };

    /* Where the line comes from (Storm 2026-10-22: lines should "say they are taking from the
     * pantry or fridge or freezer"): an icon before the stats -- fridge, jar, snowflake, or the
     * cart / basket for what still has to be bought (ticked off = bought). Worked out by the
     * server walking the week's meals in order out of what's on hand, so the lines add up to
     * the list. The edge takes the same colour. False = nothing known yet. */
    const paintSource = (row, ing) => {
      const old = row.querySelector(".mb-from");
      if (old) old.remove();
      row.classList.remove("from-fridge", "from-pantry", "from-freezer");
      const line = ing && sources && sources.lines ? sources.lines[ing.id] : null;
      if (!line) return false;
      const icons = [], says = [];
      Object.entries(line.from).sort((a, b) => b[1] - a[1]).forEach(([where, g]) => {
        icons.push(`<span class="where-${where}">${App.icon(GP_PLACES[where][0])}</span>`);
        const amt = line.from_text[where];
        says.push(`${amt ? amt + " " : ""}from the ${where === "pantry" ? "pantry" : where}`);
      });
      if (line.short_g && line.list === "make") {
        // made in bulk (bulk.js): not bought -- there isn't enough of the pot left
        icons.push(`<span class="to-make">${App.icon(GP_POT)}</span>`);
        says.push(`${line.short_text ? line.short_text + " " : ""}more to make in bulk`);
      } else if (line.short_g) {
        const market = line.list === "market";
        icons.push(`<span class="${line.bought ? "bought" : market ? "to-market" : "to-grocery"}">${App.icon(market ? GP_BASKET : GP_CART)}</span>`);
        const amt = line.short_text && line.short_g > 0.01 ? line.short_text + " " : "";
        says.push(line.bought ? `${amt}bought` : `${amt}on the ${market ? "farmer's market" : "grocery"} list`);
      }
      const main = Object.keys(line.from).sort((a, b) => line.from[b] - line.from[a])[0];
      row.classList.remove("to-market", "to-grocery");
      if (main) row.classList.add("from-" + main);
      else if (line.list !== "make") row.classList.add(line.list === "market" ? "to-market" : "to-grocery");
      row.title = says.join(" · ");
      const badge = App.el(`<span class="mb-from" title="${App.esc(row.title)}">${icons.slice(0, 2).join("")}</span>`);
      row.insertBefore(badge, row.querySelector(".mb-stat"));
      return true;
    };

    /* Whose meal (Storm 2026-10-23: "some we could designate to joanna or to me like extra
     * meals"): everyone's by default, split evenly; a tap makes it one person's, then the next
     * person's, then everyone's again. Nutrition counts it for them alone (gaps.py, household.portion). */
    const whoBtn = el.querySelector(".mb-who");
    const eaters = () => (slot() && slot().eaters) || null;
    const drawWho = () => {
      const people = host.members();
      const mine = eaters();
      whoBtn.hidden = people.length < 2 || !slot();
      const names = mine ? people.filter(m => mine.includes(m.id)).map(m => m.name) : [];
      whoBtn.classList.toggle("on", names.length > 0);
      whoBtn.innerHTML = `${App.icon(names.length ? MB_PERSON : MB_PEOPLE)}${names.length ? `<span>${App.esc(names.join(" & "))}</span>` : ""}`;
      whoBtn.title = names.length ? `${names.join(" & ")}'s — tap for the next person` : "Everyone's, split evenly — tap to make it one person's";
    };
    whoBtn.addEventListener("click", async () => {
      const people = host.members(), mine = eaters();
      const at = mine && mine.length === 1 ? people.findIndex(m => m.id === mine[0]) : -1;
      const next = at + 1 < people.length ? [people[at + 1].id] : [];
      try {
        host.onWeekChanged(await App.api(`/api/board/${host.getWeek().week_start}/slots/${key}/eaters`,
          { method: "PUT", body: { member_ids: next } }));
        drawWho();
        host.onStatsChanged();
      } catch (err) { App.toast(err.message); }
    });

    const applySources = (entry) => {
      sources = entry || null;
      drawWho();
      el.classList.toggle("served", !!(sources && sources.served));
      Array.from(rowsWrap.children).forEach(markDestination);
      drawLink();
      drawFoot();
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
        // × on a suggestion: a typo or a one-off goes away (deleted if nothing uses it)
        onDelete: async (item) => {
          const res = await App.api(`/api/ingredients/${item.id}/forget`, { method: "POST" });
          if (res.deleted) host.ingredients.splice(host.ingredients.findIndex(i => i.id === item.id) >>> 0, 1);
          App.toast(res.deleted ? `${item.name} deleted` : `${item.name} won't be suggested`);
        },
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

    /* One empty line per meal, always at the end (Storm 2026-10-23: "auto remove extra
     * ingredients slots that are empty and have no more than one empty slot at a time"). The
     * line being typed in is the exception: emptied on purpose, it stays until focus leaves it,
     * and while it's there it is the one empty line. */
    const ensureBlankRow = () => {
      const rows = Array.from(rowsWrap.children);
      const focused = rows.find(r => r.contains(document.activeElement));
      const last = rows[rows.length - 1];
      const keep = focused && rowIsBlank(focused) ? focused : (last && rowIsBlank(last) ? last : null);
      rows.forEach(r => { if (r !== keep && rowIsBlank(r)) r.remove(); });
      if (!keep) rowsWrap.appendChild(makeRow(null));
    };
    rowsWrap.addEventListener("focusout", () => setTimeout(ensureBlankRow, 0));

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
      linkWrap.classList.remove("keep");
      const s = slot();
      if (!s) return;
      const served = sources && sources.served;
      if (served || s.fresh) {
        // eaten from a batch put away (batches.py): tap to cook it fresh instead, and back
        const where = served ? served.where : "freezer";
        const btn = App.el(served
          ? `<button class="mb-tag mb-served where-${where}" title="Its ingredients aren't on the list — tap to cook it fresh instead">${App.icon(GP_PLACES[where][0])}from the ${where}${served.from_key ? ` · ${_mbShortDay(served.made)}'s batch` : ""}${served.left ? ` · ${served.left} left` : ""}</button>`
          : `<button class="mb-tag mb-fresh" title="Tap to eat servings put away instead, when there are some">${App.icon(MB_FLAME)}cooking fresh</button>`);
        btn.addEventListener("click", async () => {
          try {
            host.onWeekChanged(await App.api(`/api/board/${host.getWeek().week_start}/slots/${key}/fresh`,
              { method: "PUT", body: { fresh: !!served } }));
          } catch (err) { App.toast(err.message); }
        });
        linkWrap.appendChild(btn);
        linkWrap.classList.add("keep");
        return;
      }
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

    /* Making it in bulk (Storm 2026-10-22: "a button at the bottom to click if we are making it
     * in bulk how many servings we are storing in the fridge or freezer"). The lines above are
     * what goes in the pot -- the list buys exactly those; the servings put away then feed later
     * meals of the same name, whose ingredients drop off the list (batches.py). */
    let bulkOpen = false;
    const drawFoot = () => {
      footWrap.innerHTML = "";
      const s = slot();
      if (!s) return;
      const st = s.store;
      const stored = sources && sources.stored;
      if (bulkOpen) {
        let where = st ? st.where : "freezer";
        const ed = App.el(`<div class="mb-bulk-ed">
          ${App.icon(MB_BULK)}
          <button class="icon-btn mb-bulk-dn" title="Fewer">−</button>
          <input class="mb-bulk-n num" type="number" min="0" step="1" value="${st ? st.n : 4}" title="Servings put away">
          <button class="icon-btn mb-bulk-up" title="More">+</button>
          <span class="gp-stock-pick">${["fridge", "freezer"].map(w =>
            `<button class="icon-btn where-${w}${w === where ? " on" : ""}" data-where="${w}" title="${GP_PLACES[w][1]}">${App.icon(GP_PLACES[w][0])}</button>`).join("")}</span>
          <button class="icon-btn mb-bulk-ok" title="Save">${App.icon('<path d="M20 6 9 17l-5-5"/>')}</button>
          ${st ? `<button class="icon-btn mb-bulk-off" title="Not a batch">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button>` : ""}
        </div>`);
        const n = ed.querySelector(".mb-bulk-n");
        ed.querySelector(".mb-bulk-dn").addEventListener("click", () => { n.value = Math.max(0, (Number(n.value) || 0) - 1); });
        ed.querySelector(".mb-bulk-up").addEventListener("click", () => { n.value = (Number(n.value) || 0) + 1; });
        ed.querySelectorAll(".gp-stock-pick button").forEach(b => b.addEventListener("click", () => {
          where = b.dataset.where;
          ed.querySelectorAll(".gp-stock-pick button").forEach(x => x.classList.toggle("on", x === b));
        }));
        const save = async (count) => {
          bulkOpen = false;
          try {
            host.onWeekChanged(await App.api(`/api/board/${host.getWeek().week_start}/slots/${key}/store`,
              { method: "PUT", body: { n: count, where } }));
            App.toast(count ? `${count} serving${count === 1 ? "" : "s"} into the ${where}` : "Not a batch");
          } catch (err) { App.toast(err.message); drawFoot(); }
        };
        ed.querySelector(".mb-bulk-ok").addEventListener("click", () => save(Math.max(0, Number(n.value) || 0)));
        ed.querySelector(".mb-bulk-off")?.addEventListener("click", () => save(0));
        n.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); save(Math.max(0, Number(n.value) || 0)); }
          else if (e.key === "Escape") { e.stopPropagation(); bulkOpen = false; drawFoot(); }
        });
        footWrap.appendChild(ed);
        requestAnimationFrame(() => { n.focus(); n.select(); });
        return;
      }
      const btn = st
        ? App.el(`<button class="mb-tag mb-bulk-on where-${st.where}" title="Making it in bulk — tap to change">${App.icon(GP_PLACES[st.where][0])}+${st.n} into the ${st.where}${stored && stored.left !== st.n ? ` · ${stored.left} left` : ""}</button>`)
        : App.el(`<button class="icon-btn mb-bulk" title="Making it in bulk? Servings to put in the fridge or freezer">${App.icon(MB_BULK)}</button>`);
      btn.addEventListener("click", () => { bulkOpen = true; drawFoot(); });
      footWrap.appendChild(btn);
    };

    /* Where the recipe came from (Storm 2026-10-22: "a button for uploading or looking at a real
     * link to a website recipe or a picture from a cookbook recipe … next to the name"). Kept on
     * the recipe, so every week that cooks it has it. Pictures are shrunk here, saved as files
     * beside the plan (they ride Dropbox to the phones). */
    const srcBtn = el.querySelector(".mb-source");
    const syncSource = () => {
      const r = matchedRecipe;
      const has = !!(r && (r.source_url || (r.photos || []).length));
      srcBtn.classList.toggle("on", has);
      srcBtn.title = has ? "The recipe" : "Recipe: a link or a cookbook photo";
    };
    const saveRecipe = async (fields) => {
      const res = await App.api(`/api/recipes/${matchedRecipe.id}`, { method: "PUT", body: fields });
      const at = host.recipes.findIndex(r => r.id === res.recipe.id);
      if (at >= 0) host.recipes[at] = res.recipe;
      matchedRecipe = res.recipe;
      syncSource();
      return res.recipe;
    };
    const openSource = async () => {
      if (!nameInput.value.trim()) { App.toast("Name the meal first"); return; }
      await commit().catch(err => App.toast(err.message));   // makes the recipe if it's new
      if (!matchedRecipe) { App.toast("Name the meal first"); return; }
      document.querySelectorAll(".mb-src-menu").forEach(m => m.remove());
      const menu = App.el(`<div class="mb-menu mb-src-menu">
        <div class="mb-src-link">
          ${App.icon(MB_LINK)}
          <input class="mb-src-url" type="url" placeholder="Paste a recipe link…" spellcheck="false" enterkeyhint="done">
          <a class="icon-btn mb-src-open" target="_blank" rel="noopener" title="Open the recipe">${App.icon(MB_OPEN)}</a>
        </div>
        <div class="mb-src-photos"></div>
      </div>`);
      const url = menu.querySelector(".mb-src-url"), open = menu.querySelector(".mb-src-open");
      const photos = menu.querySelector(".mb-src-photos");
      const showUrl = () => {
        const u = matchedRecipe.source_url || "";
        url.value = u;
        open.hidden = !u;
        if (u) open.href = /^https?:\/\//i.test(u) ? u : "https://" + u;
      };
      const drawPhotos = () => {
        photos.innerHTML = "";
        (matchedRecipe.photos || []).forEach(name => {
          const t = App.el(`<span class="mb-src-thumb"><img alt=""><button class="icon-btn mb-src-x" title="Remove this photo">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button></span>`);
          App.photoUrl(name).then(u => { t.querySelector("img").src = u; }).catch(() => t.classList.add("missing"));
          t.querySelector("img").addEventListener("click", () => App.showPhoto(name));
          t.querySelector(".mb-src-x").addEventListener("click", async (e) => {
            e.stopPropagation();
            await saveRecipe({ photos: (matchedRecipe.photos || []).filter(p => p !== name) }).catch(err => App.toast(err.message));
            drawPhotos();
          });
          photos.appendChild(t);
        });
        const add = App.el(`<label class="icon-btn mb-src-add" title="Add a photo of the recipe">${App.icon(MB_CAMERA)}<input type="file" accept="image/*" hidden></label>`);
        add.querySelector("input").addEventListener("change", async (e) => {
          const files = Array.from(e.target.files || []);
          for (const f of files) {
            try {
              App.toast("Saving the photo…");
              const data = await App.shrinkPhoto(f);
              const res = await App.api("/api/photos", { method: "POST", body: { data } });
              await saveRecipe({ photos: [...(matchedRecipe.photos || []), res.name] });
            } catch (err) { App.toast(`Couldn't save the photo: ${err.message}`); }
          }
          drawPhotos();
        });
        photos.appendChild(add);
      };
      const saveUrl = async () => {
        const u = url.value.trim();
        if (u === (matchedRecipe.source_url || "")) return;
        try { await saveRecipe({ source_url: u }); showUrl(); App.toast(u ? "Link saved" : "Link removed"); }
        catch (err) { App.toast(err.message); }
      };
      url.addEventListener("change", saveUrl);
      url.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.keyCode === 13) { e.preventDefault(); url.blur(); }
        if (e.key === "Escape") { e.stopPropagation(); close(); }
      });
      showUrl();
      drawPhotos();
      document.body.appendChild(menu);
      const rect = srcBtn.getBoundingClientRect();
      menu.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 200)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left - 200, window.innerWidth - menu.offsetWidth - 8))}px`;
      const close = () => { menu.remove(); document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); };
      const away = (e) => { if (!menu.contains(e.target) && !e.target.closest(".mb-photo-view")) { saveUrl(); close(); } };
      setTimeout(() => { document.addEventListener("mousedown", away); document.addEventListener("touchstart", away, { passive: true }); }, 0);
      if (!matchedRecipe.source_url && !(matchedRecipe.photos || []).length) url.focus();
    };
    srcBtn.addEventListener("click", (e) => { e.preventDefault(); openSource(); });

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
      bulkOpen = false;
      drawLink();
      drawFoot();
      drawRepeat();
      syncStar();
      syncSource();
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
      const all = readRows();
      for (const r of all) {
        if (!r.name) continue;
        // half a word left behind ("frozen" beside "frozen dragonfruit pieces", no amount): not a line
        const n = r.name.toLowerCase();
        if (!r.amount.trim() && all.some(o => o !== r && o.name.toLowerCase().startsWith(n + " "))) continue;
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
      drawFoot();
      drawRepeat();
      syncSource();
      // Ingredients minted by this commit now have a shopping list -- show
      // where each line is going without waiting for a redraw.
      Array.from(rowsWrap.children).forEach(markDestination);
    };

    // ── wiring ───────────────────────────────────────────────────────
    el.addEventListener("input", (e) => {
      markDirty();
      if (e.target.classList.contains("mb-ing") || e.target.classList.contains("mb-amt")) {
        ensureBlankRow();
        schedulePreview();
      }
      if (e.target === nameInput) {
        nameInput.title = nameInput.value;
        queueMicrotask(syncStar);
        const found = recipeByName(nameInput.value);
        if (found && (!matchedRecipe || found.id !== matchedRecipe.id)) {
          matchedRecipe = found;
          ownRecipe = false;
          // picked a past meal — bring along the lines it was last made with, amounts and all
          drawRows(found.last_ingredients || found.ingredients);
        } else if (!found) {
          matchedRecipe = null;
        }
        syncSource();
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
      // an extra ("Also") meal goes away entirely -- breakfast, lunch and dinner each keep one block
      if (index) { el.remove(); host.removeBlock(key); return; }
      matchedRecipe = null;
      ownRecipe = false;
      servInput.value = 1;
      el.classList.remove("filled");
      linkWrap.innerHTML = "";
      footWrap.innerHTML = "";
      sources = null;
      el.classList.remove("served");
      syncSource();
      drawRows(null);
    });

    draw();

    return {
      el, date, meal, key,
      knownRows,
      applyPreview,
      refreshStats,
      redraw: draw,
      applySources,
      get totals() { return totals; },
      eaters,
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
