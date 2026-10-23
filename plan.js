/* The plan — the whole app, really. One column per day; each column is a
 * day header, the three meals stacked as lists, and that day's totals at
 * the foot. Meals line up row-for-row across the columns (every day's
 * breakfast shares a grid row), so the week reads as a list rather than a
 * spreadsheet of cells you have to open.
 *
 * Saturday (the shopping day) shows all seven columns; every other day
 * shows just that day, wide. A manual Auto·Week·Day switch overrides the
 * weekday for the session — genuinely useful, and what verification uses
 * to force either mode on a Thursday.
 *
 * The grocery list is docked on the right in both modes, always, and it
 * is always the *coming* week's — you shop for the week ahead, so a list
 * for the week you're currently living through is the wrong list. It's
 * anchored to today, not to whatever week has been paged to. The cart
 * button (or "G") hides it for the session if it's ever in the way.
 *
 * Nothing here opens a modal: blocks (mealblock.js) edit in place and
 * persist themselves, handing back the updated week so this file can keep
 * the day footers, the grocery panel and the badge honest.
 */
window.App = window.App || {};

const PLAN_MEALS = ["breakfast", "lunch", "dinner"];
const WEEK_VIEW_WEEKDAY = 6;                 // JS getDay(): 0=Sunday..6=Saturday
const MEAL_HOUR_BANDS = { breakfast: [0, 11], lunch: [11, 16], dinner: [16, 24] };

App.plan = {
  _forceMode: null,     // null (auto) | "week" | "day"
  _date: null,          // anchor date: the day shown, or any day in the week shown
  _week: null,
  _recipes: [],
  _ingredients: [],
  _options: {},
  _blocks: [],
  _listWeek: null,      // week_start of the list beside the plan: always next week's
  _marketWeek: null,    // the farmer's market list's week (it resets separately)
  _listOpen: true,
  _listTouched: false,
  _bandTimer: null,
  _band: null,

  _isWeekMode() {
    if (this._forceMode) return this._forceMode === "week";
    return new Date().getDay() === WEEK_VIEW_WEEKDAY;
  },

  async render(body) {
    if (!this._date) this._date = _planToday();
    clearInterval(this._bandTimer);
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    try {
      await this._load(body);
    } catch (err) {
      body.innerHTML = `<div class="notice bad">${App.icon('<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>')}<div>${App.esc(err.message)}</div></div>`;
    }
  },

  async _load(body) {
    const today = _planToday();
    const day = await App.api(`/api/board/day/${this._date}`);
    const [week, recipesRes, ingredientsRes, ob, ol, od, todayDay] = await Promise.all([
      App.api(`/api/board?week=${day.week_start}`),
      App.api("/api/recipes"),
      App.api("/api/ingredients"),
      App.api("/api/board/meal-options?meal=breakfast"),
      App.api("/api/board/meal-options?meal=lunch"),
      App.api("/api/board/meal-options?meal=dinner"),
      // the list is the coming week's wherever the plan has been steered to,
      // so it's anchored to today, not to the week on screen
      this._date === today ? Promise.resolve(day) : App.api(`/api/board/day/${today}`),
    ]);
    // The list is for the week you SHOP for: normally the coming one
    // (reup day is Sunday, so on Saturday the week on screen is the one
    // ending today). But when the plan has been paged forward to a future
    // week, the list follows it -- otherwise you'd be typing meals into a
    // week whose ingredients never appear on the list beside them.
    // Which week that is moves on every Monday, or once the week's shop is done (groceries.list_week).
    const shopWeek = todayDay.list_week || todayDay.next_week_start;
    const marketWeek = todayDay.market_week || shopWeek;      // the market list resets on its own
    this._listWeek = day.week_start > shopWeek ? day.week_start : shopWeek;
    this._marketWeek = day.week_start > marketWeek ? day.week_start : marketWeek;
    this._week = week;
    this._recipes = recipesRes.recipes;
    this._ingredients = ingredientsRes.ingredients;
    this._options = { breakfast: ob.options, lunch: ol.options, dinner: od.options };
    this._draw(body);
  },

  /* Swipe the day sideways for the next / previous one (phones). The day follows the finger,
   * flies off past ~a fifth of the width, and the new one slides in from the far side. A swipe
   * that starts on an ingredient line removes that line instead (App.swipeAway), and a field
   * being typed in keeps its touches. */
  _wireDaySwipe(cols, body) {
    if (this._slideIn) {                       // arriving from a swipe: come in from that side
      const from = this._slideIn;
      this._slideIn = 0;
      cols.style.transition = "none";
      cols.style.transform = `translateX(${from * 35}%)`;
      cols.style.opacity = "0";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        cols.style.transition = "transform .22s ease-out, opacity .22s";
        cols.style.transform = "";
        cols.style.opacity = "";
      }));
    }
    let x0 = 0, y0 = 0, dx = 0, mode = null;
    cols.addEventListener("touchstart", (e) => {
      const field = e.target.closest("input, textarea");
      if (e.touches.length !== 1 || e.target.closest(".swipe-row, .list-panel, .isg")
          || (field && field === document.activeElement)) { mode = "no"; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null;
    }, { passive: true });
    cols.addEventListener("touchmove", (e) => {
      if (mode === "no") return;
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (mode === null) {
        if (Math.abs(mx) < 12 && Math.abs(my) < 12) return;
        mode = Math.abs(mx) > Math.abs(my) * 1.5 ? "day" : "no";
        if (mode === "day") cols.style.transition = "none";
      }
      if (mode !== "day") return;
      dx = mx;
      cols.style.transform = `translateX(${dx * 0.9}px)`;
      cols.style.opacity = String(Math.max(0.35, 1 - Math.abs(dx) / cols.offsetWidth));
    }, { passive: true });
    const end = () => {
      if (mode !== "day") { mode = null; return; }
      mode = null;
      const step = dx < 0 ? 1 : -1;            // finger to the left = the next day
      cols.style.transition = "transform .18s ease-in, opacity .18s";
      if (Math.abs(dx) > Math.max(70, cols.offsetWidth * 0.22)) {
        cols.style.transform = `translateX(${-step * 100}%)`;
        cols.style.opacity = "0";
        this.flush();
        setTimeout(() => {
          this._slideIn = step;
          this._date = _planShift(this._date, step);
          this.render(body);
        }, 170);
      } else {
        cols.style.transform = "";
        cols.style.opacity = "";
      }
    };
    cols.addEventListener("touchend", end);
    cols.addEventListener("touchcancel", end);
  },

  // ── the host contract mealblock.js renders against ────────────────
  _host() {
    const self = this;
    return {
      compact: this._isWeekMode(),
      recipes: this._recipes,
      ingredients: this._ingredients,
      getWeek: () => self._week,
      optionsFor: (meal) => self._options[meal] || [],
      optionsListId: (meal) => `plan-opts-${meal}`,
      focusNextMeal: (fromKey) => self._focusNextMeal(fromKey),
      hideOption: async (meal, item) => {
        await App.api(`/api/recipes/${item.recipe_id}`, { method: "PUT", body: { hide_suggest: true } });
        self._options[meal] = (self._options[meal] || []).filter(o => o.recipe_id !== item.recipe_id);
      },
      invalidateOptions: async (meal) => {
        const res = await App.api(`/api/board/meal-options?meal=${meal}`);
        self._options[meal] = res.options;
      },
      onWeekChanged: (week) => {
        self._week = week;
        App.groceriesPanel.refresh();
        self.refreshSources();
      },
      onStatsChanged: () => self._paintDayTotals(),
      listWeek: () => self._listWeek,
      reloadWeek: () => self.render(document.getElementById("body")),
      fillWeek: (fromKey, recipeId, meal, servings) => self._fillWeek(fromKey, recipeId, meal, servings),
    };
  },

  /* Where every meal's lines come from -- fridge, dry, freezer, or the list -- and which meals
   * are eaten from a batch put away (stock.slot_sources, one call for the week). Asked again
   * after any change to the plan or the list, since a tick or a pantry edit moves it. */
  refreshSources() {
    clearTimeout(this._srcTimer);
    this._srcTimer = setTimeout(async () => {
      if (!this._week) return;
      const week = this._week.week_start;
      let res;
      try { res = await App.api(`/api/board/${week}/sources`); } catch (e) { return; }
      if (!this._week || this._week.week_start !== week) return;
      this._blocks.forEach(b => b.applySources(res.slots[b.key]));
    }, 350);
  },

  /* "Fill the rest of this week" — the same meal in that slot on every
   * remaining day, written as real slots (not a rule), because it's a
   * one-off decision about this week. Days that already have something
   * planned are left alone. */
  async _fillWeek(fromKey, recipeId, meal, servings) {
    const from = fromKey.split(":")[0];
    let week = this._week;
    const lines = (week.slots[fromKey] || {}).ingredient_overrides || null;   // the same lines, not the recipe's first ones
    for (const date of this._week.dates) {
      if (date <= from) continue;
      if (Object.keys(week.slots).some(k => k.startsWith(`${date}:${meal}`))) continue;
      week = await App.api(`/api/board/${week.week_start}/slots/${date}:${meal}`, {
        method: "PUT", body: { recipe_id: recipeId, servings_used: servings, ingredient_overrides: lines },
      });
    }
    this._week = week;
    await this.render(document.getElementById("body"));
  },

  _draw(body) {
    const weekMode = this._isWeekMode();
    const dates = weekMode ? this._week.dates : [this._date];
    // The shopping list is part of the screen, every day, not a drawer you
    // fetch on Saturday -- it only goes away if it's deliberately hidden.
    if (!this._listTouched) this._listOpen = true;
    const host = this._host();
    this._blocks = [];

    body.innerHTML = `
      ${PLAN_MEALS.map(m => `<datalist id="plan-opts-${m}">${(this._options[m] || []).map(o => `<option value="${App.esc(o.name)}">`).join("")}</datalist>`).join("")}
      <div class="plan ${weekMode ? "is-week" : "is-day"} ${this._listOpen ? "list-open" : ""}" id="plan">
        <div class="plan-cols ${weekMode ? "" : "one-day"}" id="plan-cols"></div>
        <aside class="list-panel" id="list-panel"></aside>
      </div>
    `;

    const cols = body.querySelector("#plan-cols");
    // The arithmetic that keeps seven columns and the docked list on a
    // 1366-wide screen with no sideways scroll, measured in the real shell:
    //   1366 - 250 (list) - 15 (scrollbar gutter) = 1101 usable
    //   7 x 144 + 6 x 10 (gap) + 28 (padding)     = 1096
    // 1fr spends anything wider on the columns. Change either number and
    // this has to be redone -- 146 used to fit exactly, until a slot with
    // two meals in it made the grid tall enough to want a scrollbar.
    cols.style.gridTemplateColumns = weekMode
      ? `repeat(${dates.length}, minmax(144px, 1fr))`
      : "minmax(0, 780px)";
    if (!weekMode) this._wireDaySwipe(cols, body);

    dates.forEach((date, ci) => {
      const isToday = date === _planToday();
      cols.appendChild(App.el(`
        <div class="day-col-head ${isToday ? "today" : ""}" style="grid-column:${ci + 1};grid-row:1;">
          <span class="dow">${_planDow(date)}</span>
          <span class="dnum">${_planDayNum(date)}</span>
          ${isToday ? '<span class="today-dot"></span>' : ""}
        </div>
      `));
      PLAN_MEALS.forEach((meal, mi) => {
        // One cell per day+meal, holding one meal or several. Breakfast is
        // a smoothie AND fried eggs often enough that the slot has to
        // stretch; the cell is what keeps every day's breakfast on the
        // same grid row while it does.
        const cell = App.el(`<div class="meal-cell" data-date="${date}" data-meal="${meal}"></div>`);
        cell.style.gridColumn = String(ci + 1);
        cell.style.gridRow = String(mi + 2);
        this._indicesFor(date, meal).forEach(index => {
          const blk = App.mealBlock.create(host, date, meal, index);
          cell.appendChild(blk.el);
          this._blocks.push(blk);
        });
        cell.appendChild(this._addMealButton(host, cell, date, meal));
        cols.appendChild(cell);
      });
      cols.appendChild(App.el(`
        <div class="day-col-foot" data-date="${date}" style="grid-column:${ci + 1};grid-row:5;">
          <span class="field-label">Day</span><span class="v num">—</span>
          <button class="day-low" hidden></button>
          <div class="day-gaps" hidden></div>
        </div>
      `));
    });

    this._drawNav();
    this.refreshSources();
    App.groceriesPanel.mount(body.querySelector("#list-panel"), this._listWeek,
      (n) => this._setBadge(n), "Next week", _planRange(this._listWeek, _planShift(this._listWeek, 6)), this._marketWeek);
    this._refreshAllStats();

    if (!this._isWeekMode()) {
      this._band = _currentBand();
      this._focusBand(false);
      this._bandTimer = setInterval(() => this._tickBand(), 60000);
    }
  },

  /* Which meals sit at one day+meal: always the first, plus any indexed
   * ones already saved. Sorted, so "Also" blocks keep their order. */
  _indicesFor(date, meal) {
    const found = Object.keys(this._week.slots)
      .map(k => {
        const [d, rest] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
        const [m, idx] = rest.split("~");
        return { d, m, i: idx ? Number(idx) : 0 };
      })
      .filter(s => s.d === date && s.m === meal)
      .map(s => s.i);
    const set = new Set([0, ...found]);
    return Array.from(set).sort((a, b) => a - b);
  },

  /* Adding a second meal is a real thing you do while planning, so it's a
   * button in the cell, not something hidden behind a menu. It only draws
   * the extra block -- nothing is saved until it's given a name, same as
   * every other block. */
  _addMealButton(host, cell, date, meal) {
    const btn = App.el(`<button class="meal-add" title="Another ${meal} as well">${App.icon('<path d="M12 5v14M5 12h14"/>')}</button>`);
    btn.addEventListener("click", () => {
      const used = Array.from(cell.querySelectorAll(".mb")).map(el => {
        const parts = el.dataset.key.split("~");
        return parts[1] ? Number(parts[1]) : 0;
      });
      let index = 0;
      while (used.includes(index)) index += 1;
      const blk = App.mealBlock.create(host, date, meal, index);
      cell.insertBefore(blk.el, btn);
      // Slotted in beside its neighbours, not appended: _focusNextMeal
      // walks this array, and a block tacked on the end would make Tab
      // jump from Tuesday's breakfast to Sunday's.
      const last = this._blocks.map(b => b.date === date && b.meal === meal).lastIndexOf(true);
      this._blocks.splice(last + 1, 0, blk);
      blk.el.querySelector(".mb-name").focus();
    });
    return btn;
  },

  // ── top-bar nav (shares the header slot, no second toolbar) ────────
  _drawNav() {
    const weekMode = this._isWeekMode();
    const label = weekMode
      ? _planRange(this._week.dates[0], this._week.dates[6])
      : _planFull(this._date);
    const nav = App.setNav(`
      <button class="icon-btn" id="plan-prev" title="${weekMode ? "Previous week" : "Previous day"}">${App.icon('<path d="m15 18-6-6 6-6"/>')}</button>
      <div class="plan-date">${label}</div>
      <button class="icon-btn" id="plan-next" title="${weekMode ? "Next week" : "Next day"}">${App.icon('<path d="m9 18 6-6-6-6"/>')}</button>
      <button class="btn-ghost btn-mini" id="plan-today">${weekMode ? "This week" : "Today"}</button>
      <div class="seg seg-mini" id="plan-mode">
        <button data-mode="" class="${!this._forceMode ? "active" : ""}">Auto</button>
        <button data-mode="week" class="${this._forceMode === "week" ? "active" : ""}">Week</button>
        <button data-mode="day" class="${this._forceMode === "day" ? "active" : ""}">Day</button>
      </div>
    `);
    const body = document.getElementById("body");
    const step = weekMode ? 7 : 1;
    nav.querySelector("#plan-prev").addEventListener("click", () => { this._date = _planShift(this._date, -step); this.render(body); });
    nav.querySelector("#plan-next").addEventListener("click", () => { this._date = _planShift(this._date, step); this.render(body); });
    nav.querySelector("#plan-today").addEventListener("click", () => { this._date = _planToday(); this._band = null; this.render(body); });
    nav.querySelector("#plan-mode").addEventListener("click", (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      this._forceMode = btn.dataset.mode || null;
      this.render(body);
    });
  },

  // ── stats ─────────────────────────────────────────────────────────
  /* One request for all 21 blocks on load instead of 21 -- each block
   * still refreshes itself singly while you type. */
  async _refreshAllStats() {
    const blocks = {};
    this._blocks.forEach(b => { blocks[b.key] = b.knownRows(); });
    let res;
    try { res = await App.api("/api/nutrition/preview-batch", { method: "POST", body: { blocks } }); }
    catch (e) { return; }
    this._blocks.forEach(b => {
      const p = res.blocks[b.key];
      b.applyPreview(p && p.rows.length ? p : null);
    });
    this._paintDayTotals();
  },

  _paintDayTotals() {
    const days = {};
    document.querySelectorAll(".day-col-foot").forEach(foot => {
      const date = foot.dataset.date;
      const mine = this._blocks.filter(b => b.date === date && b.totals);
      const v = foot.querySelector(".v");
      if (mine.length === 0) { v.textContent = "—"; v.title = ""; this._paintGaps(foot, null); return; }
      const sum = { calories_kcal: 0, protein_g: 0, fiber_g: 0, vitamins: {} };
      mine.forEach(b => {
        for (const k of ["calories_kcal", "protein_g", "fiber_g"]) sum[k] += b.totals[k] || 0;
        for (const [k, x] of Object.entries(b.totals.vitamins || {})) sum.vitamins[k] = (sum.vitamins[k] || 0) + x;
      });
      v.textContent = `${Math.round(sum.calories_kcal).toLocaleString()} kcal · ${sum.protein_g.toFixed(0)}g P · ${sum.fiber_g.toFixed(0)}g F`;
      v.title = `${Math.round(sum.calories_kcal)} kcal · ${sum.protein_g.toFixed(1)} g protein · ${sum.fiber_g.toFixed(1)} g fiber`;
      days[date] = { totals: sum, ingredient_ids: [...new Set(mine.flatMap(b => b.knownRows().map(r => r.ingredient_id)))] };
    });
    clearTimeout(this._gapsTimer);
    this._gapsTimer = setTimeout(() => this._refreshGaps(days), 400);
  },

  /* What the day is low in, and whole foods that would fill it (gaps.py): the foot gets a
   * "low" chip; tapping it opens the list -- already open on a single day. */
  async _refreshGaps(days) {
    if (!Object.keys(days).length) return;
    const seq = this._gapsSeq = (this._gapsSeq || 0) + 1;
    let res;
    try { res = await App.api("/api/nutrition/gaps", { method: "POST", body: { days } }); }
    catch (e) { return; }
    if (seq !== this._gapsSeq) return;      // a later edit's answer is on its way
    document.querySelectorAll(".day-col-foot").forEach(foot => {
      const d = res.days[foot.dataset.date];
      if (d) this._paintGaps(foot, d);
    });
  },

  _paintGaps(foot, day) {
    const chip = foot.querySelector(".day-low"), box = foot.querySelector(".day-gaps");
    if (!chip) return;
    if (!day || !day.judged || !day.low.length) {
      chip.hidden = true; box.hidden = true; box.innerHTML = "";
      if (day && day.judged) { chip.hidden = false; chip.className = "day-low ok"; chip.innerHTML = `${App.icon('<path d="M20 6 9 17l-5-5"/>')}`; chip.title = "Nothing low today"; }
      return;
    }
    const whoText = (l) => l.who && l.who.length ? ` (${l.who.join(", ")})` : "";
    const names = day.low.map(l => l.label + whoText(l));
    chip.hidden = false;
    chip.className = "day-low";
    chip.innerHTML = `${App.icon(GP_WARN)}<span>${this._isWeekMode() ? `${names.length} low` : `Low: ${App.esc(names.slice(0, 4).join(" · "))}${names.length > 4 ? ` +${names.length - 4}` : ""}`}</span>`;
    chip.title = day.low.map(l => `${l.label}${whoText(l)}: ${l.have} of ${l.target} ${l.unit} (${l.pct}%)`).join("\n");
    const helps = (c) => c.helps.map(h => `<span class="dg-help">+${h.amount}${h.unit === "g" ? "g" : " " + h.unit} ${App.esc(h.label)}</span>`).join("");
    const row = (c, kind) => `
      <div class="dg-row" data-name="${App.esc(c.name)}">
        ${kind === "buy" ? `<button class="icon-btn dg-buy" title="Add to the list">${App.icon(GP_PLUS)}</button>`
                         : `<span class="dg-mark${c.in_stock ? " here" : ""}" title="${c.in_stock ? "In the pantry now" : "You've bought it before"}">${App.icon(c.in_stock ? GP_PANTRY : GP_USUAL)}</span>`}
        <span class="dg-name">${App.esc(c.name)}</span><span class="dg-por num">${App.esc(c.portion)}</span>
        <span class="dg-helps num">${helps(c)}</span>
      </div>`;
    box.innerHTML = `
      <div class="dg-lows">${day.low.map(l => `
        <span class="dg-low" title="${l.have} of ${l.target} ${l.unit}${App.esc(whoText(l))}"><span>${App.esc(l.label)}${l.who && l.who.length ? ` <span class="dg-who">${App.esc(l.who.join(", "))}</span>` : ""}</span><span class="dg-bar"><i style="width:${Math.min(100, l.pct)}%"></i></span><span class="num">${l.pct}%</span></span>`).join("")}</div>
      ${day.have.length ? `<div class="dg-head">${App.icon(GP_PANTRY)}<span>Already buy</span></div>${day.have.map(c => row(c, "have")).join("")}` : ""}
      ${day.buy.length ? `<div class="dg-head">${App.icon(GP_CART)}<span>Could buy</span></div>${day.buy.map(c => row(c, "buy")).join("")}` : ""}`;
    box.querySelectorAll(".dg-buy").forEach(btn => btn.addEventListener("click", async () => {
      const name = btn.closest(".dg-row").dataset.name;
      btn.disabled = true;
      try {
        await App.api("/api/nutrition/gaps/buy", { method: "POST", body: { name, week: this._listWeek, market_week: this._marketWeek } });
        App.toast(`${name}: on the list`);
        btn.innerHTML = App.icon('<path d="M20 6 9 17l-5-5"/>');
        App.groceriesPanel.refresh();
      } catch (e) { btn.disabled = false; App.toast(`Couldn't add ${name}`); }
    }));
    const date = foot.dataset.date;
    this._gapsOpen = this._gapsOpen || {};
    const open = this._gapsOpen[date] ?? !this._isWeekMode();
    box.hidden = !open;
    foot.classList.toggle("gaps-open", open);
    if (!chip._wired) {
      chip._wired = true;
      chip.addEventListener("click", () => {
        if (chip.classList.contains("ok")) return;
        this._gapsOpen[foot.dataset.date] = box.hidden;
        box.hidden = !box.hidden;
        foot.classList.toggle("gaps-open", !box.hidden);
      });
    }
  },

  /* Tab off the end of a meal's lines lands on the next meal's name --
   * breakfast, lunch, dinner, then the next day. The plan owns this
   * because it's the only place that knows what order the blocks are in
   * (which differs between the week grid and one wide day). */
  _focusNextMeal(fromKey) {
    const at = this._blocks.findIndex(b => b.key === fromKey);
    const next = at >= 0 ? this._blocks[at + 1] : null;
    if (!next) {
      if (document.activeElement) document.activeElement.blur();
      return;
    }
    const name = next.el.querySelector(".mb-name");
    name.focus();
    name.select();
    next.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  },

  // ── grocery list panel ────────────────────────────────────────────
  toggleList(force) {
    const plan = document.getElementById("plan");
    if (!plan) return;
    const next = force === undefined ? !this._listOpen : !!force;
    if (next === this._listOpen) return;   // a stray Escape shouldn't count as "I closed it"
    this._listTouched = true;
    this._listOpen = next;
    plan.classList.toggle("list-open", this._listOpen);
    if (this._listOpen) {
      App.groceriesPanel.refresh();
      const first = plan.querySelector(".list-panel input");
      if (first) first.focus();
    }
  },

  _setBadge(n) {
    const badge = document.getElementById("list-count");
    if (!badge) return;
    badge.textContent = n > 0 ? String(n) : "";
    badge.classList.toggle("on", n > 0);
  },

  // ── "auto move down to lunch at lunch time" ───────────────────────
  _tickBand() {
    if (this._isWeekMode() || this._date !== _planToday()) return;
    const band = _currentBand();
    if (band === this._band) return;
    this._band = band;
    this._focusBand(true);
  },

  _focusBand(smooth) {
    if (this._date !== _planToday()) return;
    const band = this._band || _currentBand();
    document.querySelectorAll(".mb.now").forEach(el => el.classList.remove("now"));
    const blk = this._blocks.find(b => b.date === this._date && b.meal === band);
    if (!blk) return;
    blk.el.classList.add("now");
    // never yank the page out from under someone mid-edit
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".mb")) return;
    blk.el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  },

  flush() {
    this._blocks.forEach(b => b.flush());
  },
};

// A half-finished line shouldn't die because the window lost focus.
window.addEventListener("pagehide", () => App.plan.flush());
document.addEventListener("visibilitychange", () => { if (document.hidden) App.plan.flush(); });

function _currentBand() {
  const hour = new Date().getHours();
  for (const [meal, [start, end]] of Object.entries(MEAL_HOUR_BANDS)) {
    if (hour >= start && hour < end) return meal;
  }
  return "dinner";
}
function _planToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function _planShift(iso, days) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function _planDow(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
}
function _planDayNum(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function _planFull(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
function _planRange(a, b) {
  const s = new Date(a + "T00:00:00"), e = new Date(b + "T00:00:00");
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
