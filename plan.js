/* The plan — the whole app, really. One column per day; each column is a
 * day header, the three meals stacked as lists, and that day's totals at
 * the foot. Meals line up row-for-row across the columns (every day's
 * breakfast shares a grid row), so the week reads as a list rather than a
 * spreadsheet of cells you have to open.
 *
 * Friday shows all seven columns (Storm 2026-10-31); every other day
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
const WEEK_VIEW_WEEKDAY = 5;                 // JS getDay(): 0=Sunday..6=Saturday
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

  /* Redrawing the same screen (a save, or the background change check) must not blank it to "Loading…"
   * or throw away where you were scrolled: it keeps the old screen up until the new one is ready, and
   * puts the scroll positions back. `soft` (the background check) also does nothing at all when what
   * it fetched is what's already drawn. Only moving to another day / mode starts from a clean screen. */
  async render(body, soft = false) {
    if (!this._date) this._date = _planToday();
    const prev = body.querySelector("#plan-cols");
    const keep = !!prev && this._drawnFor === `${this._date}|${this._isWeekMode()}`;
    const panel = body.querySelector("#list-panel");
    const paneOf = (c) => c && c.querySelector(`:scope > .day-col[data-date="${this._date}"]`);
    const pane0 = keep ? paneOf(prev) : null;
    const pos = keep ? { p: pane0 ? pane0.scrollTop : 0, c: prev.scrollTop, cl: prev.scrollLeft, b: body.scrollTop, l: panel ? panel.scrollTop : 0 } : null;
    if (!keep) {
      clearInterval(this._bandTimer);
      if (!this._fast) body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    }
    try {
      const drew = await this._load(body, soft && keep);
      if (pos && drew !== false) {
        const c = body.querySelector("#plan-cols"), l = body.querySelector("#list-panel");
        if (c) { c.scrollTop = pos.c; c.scrollLeft = pos.cl; const p = paneOf(c); if (p && pos.p) p.scrollTop = pos.p; }
        body.scrollTop = pos.b;
        if (l) l.scrollTop = pos.l;
      }
    } catch (err) {
      body.innerHTML = `<div class="notice bad">${App.icon('<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/>')}<div>${App.esc(err.message)}</div></div>`;
    }
  },

  /* The stored week (Sun-Sat, shifted by the reup day) a date lives in, worked out from the anchor
   * week the server told us about. */
  _wkOf(date) {
    const days = Math.round((Date.parse(date) - Date.parse(this._baseWs)) / 864e5);
    return _planShift(this._baseWs, Math.floor(days / 7) * 7);
  },

  /* One week-shaped object for the blocks to read: the window's dates, every loaded week's slots. */
  _merge() {
    const keys = Object.keys(this._weeks).sort();
    const first = this._weeks[this._baseWs] || this._weeks[keys[0]];
    this._week = {
      week_start: first.week_start,
      dates: this._window || first.dates,
      slots: Object.assign({}, ...keys.map(k => this._weeks[k].slots)),
      leftover_groups: Object.assign({}, ...keys.map(k => this._weeks[k].leftover_groups)),
    };
  },

  /* Someone else changed the data while a box has focus (a recipe shared in from the Recipes app):
   * the lists the meal-name dropdown reads are refreshed IN PLACE -- nothing redrawn, nothing blurred,
   * so what's being typed is untouched and the new recipe is offered under the finger. */
  async refreshLists() {
    if (!this._recipes || !this._options) return;
    try {
      const [r, ob, ol, od] = await Promise.all([
        App.api("/api/recipes"),
        App.api("/api/board/meal-options?meal=breakfast"),
        App.api("/api/board/meal-options?meal=lunch"),
        App.api("/api/board/meal-options?meal=dinner"),
      ]);
      if (r.recipes.length !== this._recipes.length || JSON.stringify(r.recipes.map(x => x.id + x.name + !!x.hide_suggest)) !== JSON.stringify(this._recipes.map(x => x.id + x.name + !!x.hide_suggest))) {
        this._recipes.splice(0, this._recipes.length, ...r.recipes);
      }
      this._options = { breakfast: ob.options, lunch: ol.options, dinner: od.options };
      App.ingSuggest.refresh();
    } catch (e) { /* offline: the next quiet look gets it */ }
  },

  /* Going to the next / previous day inside the week already loaded needs no fetching: the day is drawn from
   * memory at once, the shopping list panel is kept as it is, and a quiet refresh a moment later picks up anything
   * changed elsewhere. Anything else (another week, week view, first draw) takes the normal path. */
  _canFast(date) {
    return !this._isWeekMode() && !!this._drawnFor && !!this._weeks && !!this._recipes && !!this._options
      && !!this._weeks[this._wkOf(date)];
  },

  /* the ‹ › buttons: glide the strip to the next day (it lands like a swipe), else the plain step */
  _glide(body, step) {
    const cols = document.getElementById("plan-cols");
    const pane = this._stripOn && cols ? cols.querySelector(`:scope > .day-col[data-date="${_planShift(this._date, step)}"]`) : null;
    if (!pane) return this._stepDay(body, step);
    cols.scrollTo({ left: pane.offsetLeft, behavior: "smooth" });
  },

  _stepDay(body, step) {
    const to = _planShift(this._date, step);
    this._fast = this._canFast(to);
    this._date = to;
    return this.render(body);
  },

  async _load(body, soft = false) {
    if (this._fast) {
      this._fast = false;
      const old = body.querySelector("#list-panel");
      if (old) { old.remove(); this._reusePanel = old; }
      this._merge();
      this._draw(body);
      this._drawnFor = `${this._date}|${this._isWeekMode()}`;
      clearTimeout(this._quietTimer);
      this._quietTimer = setTimeout(() => this.render(body, true), 1200);     // pick up anything changed elsewhere
      return;
    }
    const today = _planToday();
    const saved0 = this._saveSeq || 0;          // a save that lands while this is fetching makes what it fetched stale
    const day = await App.api(`/api/board/day/${this._date}`);
    // Week view is the seven days going forward from the day on screen, so it can straddle two
    // stored weeks; each block reads/writes the week its own date belongs to (_wkOf).
    this._baseWs = day.week_start;
    const weekMode = this._isWeekMode();
    this._window = weekMode ? Array.from({ length: 7 }, (_, i) => _planShift(this._date, i)) : null;
    const wss = weekMode ? Array.from(new Set(this._window.map(d => this._wkOf(d)))) : [day.week_start];
    // On the phone every call is seconds of Python on the one thread, so what rarely changes (the recipe and ingredient
    // lists, the dropdown options, who's eating) is reused for 90 s between redraws (App.setView drops it).
    const phone = typeof loadPyodide === "function";
    const S = phone && this._static && Date.now() - this._static.at < 90000 ? this._static : null;
    const [weeks, recipesRes, ingredientsRes, ob, ol, od, todayDay, membersRes] = await Promise.all([
      Promise.all(wss.map(w => App.api(`/api/board?week=${w}`))),
      S ? S.recipes : App.api("/api/recipes"),
      S ? S.ingredients : App.api("/api/ingredients"),
      S ? S.ob : App.api("/api/board/meal-options?meal=breakfast"),
      S ? S.ol : App.api("/api/board/meal-options?meal=lunch"),
      S ? S.od : App.api("/api/board/meal-options?meal=dinner"),
      // the list is the coming week's wherever the plan has been steered to,
      // so it's anchored to today, not to the week on screen
      this._date === today ? Promise.resolve(day) : App.api(`/api/board/day/${today}`),
      S ? S.members : App.api("/api/household/members").catch(() => ({ members: [] })),
    ]);
    if (soft && (this._saveSeq || 0) !== saved0) return false;      // (it would paint the week as it was BEFORE the save)
    if (phone && !S) this._static = { at: Date.now(), recipes: recipesRes, ingredients: ingredientsRes, ob, ol, od, members: membersRes };
    this._members = (membersRes.members || []).filter(m => m.active !== false);
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
    if (soft) {
      // Compared with what's live on screen (our own saves already updated it), not with the last
      // full draw -- otherwise every save of ours looks like somebody else's change and redraws.
      const byStart = (a, b) => (a.week_start < b.week_start ? -1 : 1);
      const live = JSON.stringify(Object.values(this._weeks).sort(byStart));
      const fetched = JSON.stringify(weeks.slice().sort(byStart));
      // a meal just added and not named yet would vanish in a redraw
      const bare = Array.from(body.querySelectorAll('.mb[data-key*="~"]')).some(b => !b.querySelector(".mb-name").value.trim());
      // a field being typed in keeps the screen exactly as it is: the redraw waits for the next quiet check
      const ae = document.activeElement;
      const typing = !!(ae && body.contains(ae) && /^(INPUT|TEXTAREA)$/.test(ae.tagName));
      if (live === fetched || bare || typing) {
        this._recipes.splice(0, this._recipes.length, ...recipesRes.recipes);          // the page's lists are shared
        this._ingredients.splice(0, this._ingredients.length, ...ingredientsRes.ingredients);   // by reference
        App.groceriesPanel.refresh();                // (the list may have changed, though)
        return false;
      }
    }
    this._weeks = {};
    weeks.forEach(w => { this._weeks[w.week_start] = w; });
    this._merge();
    this._recipes = recipesRes.recipes;
    this._ingredients = ingredientsRes.ingredients;
    this._options = { breakfast: ob.options, lunch: ol.options, dinner: od.options };
    this._draw(body);
    this._drawnFor = `${this._date}|${this._isWeekMode()}`;
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
          this._stepDay(body, step);
        }, 170);
      } else {
        cols.style.transform = "";
        cols.style.opacity = "";
      }
    };
    cols.addEventListener("touchend", end);
    cols.addEventListener("touchcancel", end);
  },

  /* Drag a meal by its header onto another meal to swap the two; onto empty room in a cell
   * (or an empty block) to move it there. Pending edits are saved first, then the server
   * trades the slots (board.swap_slots) and the week is drawn again. */
  _wireDrag(cols) {
    let from = null;
    const clear = () => cols.querySelectorAll(".drop-on, .dragging").forEach(e => e.classList.remove("drop-on", "dragging"));
    const target = (e) => e.target.closest(".mb") || e.target.closest(".meal-cell");
    cols.addEventListener("dragstart", (e) => {
      const blk = e.target.closest && e.target.closest(".mb");
      if (!blk || !e.target.closest(".mb-head, .mb-sum")) { if (e.target.closest && e.target.closest(".mb")) e.preventDefault(); return; }
      from = blk.dataset.key;
      blk.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", from);
    });
    cols.addEventListener("dragover", (e) => {
      if (!from) return;
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      cols.querySelectorAll(".drop-on").forEach(x => { if (x !== t) x.classList.remove("drop-on"); });
      t.classList.add("drop-on");
    });
    cols.addEventListener("dragend", () => { from = null; clear(); });
    cols.addEventListener("drop", async (e) => {
      const t = target(e);
      const src = from;
      from = null; clear();
      if (!t || !src) return;
      e.preventDefault();
      await this._swapInto(src, t);
    });

    // Touch: press and hold a meal's header to pick it up (it lights up), then tap another meal
    // -- on this day or after swiping to another -- to swap them; tap the picked one to put it down.
    // (HTML5 drag never fires from a finger.)
    let timer = null, sx = 0, sy = 0, held = false;
    cols.addEventListener("touchstart", (e) => {
      const head = e.target.closest(".mb-head");
      if (!head || e.touches.length !== 1) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; held = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        held = true;
        if (navigator.vibrate) navigator.vibrate(15);
        const key = head.closest(".mb").dataset.key;
        this._pick = this._pick === key ? null : key;
        this._paintPick();
        if (this._pick) App.toast("Tap another meal to swap");
      }, 450);
    }, { passive: true });
    cols.addEventListener("touchmove", (e) => {
      if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) clearTimeout(timer);
    }, { passive: true });
    const lift = () => clearTimeout(timer);
    cols.addEventListener("touchend", lift);
    cols.addEventListener("touchcancel", lift);
    cols.addEventListener("contextmenu", (e) => { if (e.target.closest(".mb-head")) e.preventDefault(); });
    cols.addEventListener("click", async (e) => {
      if (held) { held = false; e.preventDefault(); e.stopPropagation(); return; }   // the click that ends the long press
      if (!this._pick) return;
      const t = target(e);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      const src = this._pick;
      if (t.dataset.key === src) { this._pick = null; this._paintPick(); return; }
      this._pick = null;
      await this._swapInto(src, t);
    }, true);
  },

  /* The meal picked up by touch, lit until it is swapped or put down. */
  _paintPick() {
    document.querySelectorAll("#plan-cols .mb").forEach(b => b.classList.toggle("picked", b.dataset.key === this._pick));
  },

  /* Swap meal `src` with whatever `t` is: a meal block (its key), or room in a cell (its first
   * empty block, else a new "Also" place). Pending edits are saved first. */
  async _swapInto(src, t) {
    let to = t.dataset.key;
    try {
      if (!to) {
        const slots = this._week.slots;
        const mine = Array.from(t.querySelectorAll(".mb")).map(b => b.dataset.key);
        to = mine.find(k => !slots[k]);
        if (!to) to = (await App.api(`/api/board/${this._wkOf(t.dataset.date)}/next-slot?date=${t.dataset.date}&meal=${t.dataset.meal}`)).slot_key;
      }
      if (to === src) return;
      await Promise.all(this._blocks.map(b => b.flush()));
      const wk = this._wkOf(src.split(":")[0]);
      if (wk !== this._wkOf(to.split(":")[0])) { App.toast("Meals can only trade places within the same stored week"); return; }
      await App.api(`/api/board/${wk}/slots-swap`, { method: "POST", body: { a: src, b: to } });
      this._pick = null;
      await this.render(document.getElementById("body"));
    } catch (err) { App.toast(err.message); }
  },

  /* The swap button on a meal: a short list of the other days of this week, each with what its same
   * meal is now; tap one and the two trade places (an empty day = a move). The finger-friendly way to
   * what dragging does with a mouse. */
  async _swapMenu(key, date, meal, btn) {
    document.querySelectorAll(".mb-menu.swap").forEach(x => x.remove());
    const days = Array.from({ length: 7 }, (_, i) => _planShift(date, i + 1));    // the next seven days
    const seen = { ...this._weeks };                       // day view has only its own stored week loaded
    await Promise.all(Array.from(new Set(days.map(d => this._wkOf(d)))).filter(w => !seen[w])
      .map(async w => { seen[w] = await App.api(`/api/board?week=${w}`).catch(() => ({ slots: {} })); }));
    const menu = App.el(`<div class="mb-menu swap">${days.map(d => {
      const s = (seen[this._wkOf(d)] || this._week).slots[`${d}:${meal}`];
      const rec = s && s.recipe_id ? (this._recipes || []).find(r => r.id === s.recipe_id) : null;
      const what = rec ? rec.name : (s && s.meal_name) || "";
      return `<button data-day="${d}">${App.esc(_planDow(d))} ${App.esc(_planDayNum(d))}${what ? `<span class="dim"> · ${App.esc(what)}</span>` : `<span class="dim"> · free</span>`}</button>`;
    }).join("")}</div>`);
    document.body.appendChild(menu);
    const rect = btn.getBoundingClientRect();
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left - 120, window.innerWidth - menu.offsetWidth - 8))}px`;
    const away = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away); } };
    setTimeout(() => { document.addEventListener("mousedown", away); document.addEventListener("touchstart", away); }, 0);
    menu.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-day]");
      if (!b) return;
      menu.remove();
      document.removeEventListener("mousedown", away); document.removeEventListener("touchstart", away);
      try {
        await Promise.all(this._blocks.map(x => x.flush()));
        await App.api("/api/board/slots-swap-across", { method: "POST", body: { a: key, b: `${b.dataset.day}:${meal}` } });
        App.toast(`Swapped with ${_planDow(b.dataset.day)}`);
        await this.render(document.getElementById("body"));
      } catch (err) { App.toast(err.message); }
    });
  },

  // ── the host contract mealblock.js renders against ────────────────
  _host() {
    const self = this;
    return {
      compact: this._isWeekMode(),
      swapMenu: (key, date, meal, btn) => this._swapMenu(key, date, meal, btn),
      recipes: this._recipes,
      ingredients: this._ingredients,
      getWeek: () => self._week,
      weekFor: (key) => self._wkOf(key.split(":")[0]),
      members: () => self._members || [],
      optionsFor: (meal) => self._options[meal] || [],
      optionsListId: (meal) => `plan-opts-${meal}`,
      focusNextMeal: (fromKey) => self._focusNextMeal(fromKey),
      hideOption: async (meal, item) => {
        await App.api(`/api/recipes/${item.recipe_id}`, { method: "PUT", body: { hide_suggest: true } });
        self._options[meal] = (self._options[meal] || []).filter(o => o.recipe_id !== item.recipe_id);
        const rec = self._recipes.find(r => r.id === item.recipe_id);
        if (rec) rec.hide_suggest = true;          // the dropdown also offers every saved recipe: not this one any more
      },
      invalidateOptions: async (meal) => {
        const res = await App.api(`/api/board/meal-options?meal=${meal}`);
        self._options[meal] = res.options;
      },
      onWeekChanged: (week) => {
        self._saveSeq = (self._saveSeq || 0) + 1;
        self._weeks[week.week_start] = week;
        self._merge();
        App.groceriesPanel.refresh(true);          // quick: only the buy rows + stock, so the list follows a meal change at once
        self.refreshSources();
      },
      cachedSources: (key) => (self._srcCache || {})[key] || null,
      onStatsChanged: () => self._paintDayTotals(),
      removeBlock: (key) => { self._blocks = self._blocks.filter(b => b.key !== key); self._paintDayTotals(); self._syncSides(key.split(":")[0]); },
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
      const week = this._week;
      const slots = {};
      try {
        for (const w of Object.keys(this._weeks)) Object.assign(slots, (await App.api(`/api/board/${w}/sources`)).slots);
      } catch (e) { return; }
      if (this._week !== week && (!this._week || this._week.week_start !== week.week_start)) return;
      this._srcCache = { ...(this._srcCache || {}), ...slots };
      this._blocks.forEach(b => b.applySources(slots[b.key]));
    }, 350);
  },

  /* "Fill the rest of this week" — the same meal in that slot on every
   * remaining day, written as real slots (not a rule), because it's a
   * one-off decision about this week. Days that already have something
   * planned are left alone. */
  async _fillWeek(fromKey, recipeId, meal, servings) {
    const from = fromKey.split(":")[0];
    const week = this._week;
    const lines = (week.slots[fromKey] || {}).ingredient_overrides || null;   // the same lines, not the recipe's first ones
    for (const date of this._week.dates) {
      if (date <= from) continue;
      if (Object.keys(week.slots).some(k => k.startsWith(`${date}:${meal}`))) continue;
      await App.api(`/api/board/${this._wkOf(date)}/slots/${date}:${meal}`, {
        method: "PUT", body: { recipe_id: recipeId, servings_used: servings, ingredient_overrides: lines },
      });
    }
    await this.render(document.getElementById("body"));
  },

  /* One day's column: head, the three meal cells, the foot. `flow` = stacked in its own column (week view and the
   * phone's day strip); otherwise placed on the single explicit grid of the day view. */
  _buildDay(date, holder, flow, ci, weekMode) {
    const host = this._host();
      const isToday = date === _planToday();
      const at = (row) => flow ? "" : `grid-column:${ci + 1};grid-row:${row};`;
      holder.appendChild(App.el(`
        <div class="day-col-head ${isToday ? "today" : ""}" style="${at(1)}">
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
        if (!flow) { cell.style.gridColumn = String(ci + 1); cell.style.gridRow = String(mi + 2); }
        this._indicesFor(date, meal).forEach(index => {
          const blk = App.mealBlock.create(host, date, meal, index);
          cell.appendChild(blk.el);
          this._blocks.push(blk);
        });
        // dinner gets a strip of side ideas under its main (sides.py); filled in by _paintSides
        if (meal === "dinner") {
          const strip = App.el(`<div class="side-strip" data-date="${date}" ${weekMode ? "hidden" : ""}></div>`);
          this._paintSides(strip, this._cachedSides(date));   // the last ideas for this main at once; fresh ones follow
          cell.appendChild(strip);
        }
        cell.appendChild(this._addMealButton(host, cell, date, meal));
        if (meal === "dinner") {
          let t;
          cell.addEventListener("input", (e) => { if (e.target.classList.contains("mb-name")) { clearTimeout(t); t = setTimeout(() => this._syncSides(date), 350); } });
          cell.classList.toggle("has-side", this._indicesFor(date, "dinner").length > 1);
        }
        holder.appendChild(cell);
      });
      holder.appendChild(App.el(`
        <div class="day-col-foot" data-date="${date}" style="${at(5)}">
          <span class="field-label">Day</span><span class="v num">—</span>
          <button class="day-low" hidden></button>
          <div class="day-gaps" hidden></div>
          <div class="day-bars" hidden></div>
        </div>
      `));
  },

  // ── the phone's day strip ─────────────────────────────────────────
  /* Phone, day view: the previous, this and the next day sit side by side in one sideways-scrolling strip that
   * snaps to a day (native scrolling: the finger drags the real days, with momentum, like a calendar app).
   * When it settles on another day the strip shifts by one: the far day goes, a new neighbour is built. */
  _strip() {
    return !this._isWeekMode() && window.matchMedia("(max-width: 760px)").matches
      && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
  },

  _stripDates() {
    return [-1, 0, 1].map(n => _planShift(this._date, n)).filter(d => this._weeks && this._weeks[this._wkOf(d)]);
  },

  _centerStrip(cols, smooth) {
    const pane = cols.querySelector(`:scope > .day-col[data-date="${this._date}"]`);
    if (!pane) return;
    this._stripBusy = true;
    cols.style.scrollSnapType = "none";
    cols.scrollTo({ left: pane.offsetLeft, behavior: smooth ? "smooth" : "auto" });
    requestAnimationFrame(() => requestAnimationFrame(() => { cols.style.scrollSnapType = ""; this._stripBusy = false; }));
  },

  _wireStrip(cols, body) {
    let t = 0;
    const settle = () => {
      if (this._stripBusy || !cols.isConnected) return;
      const panes = [...cols.querySelectorAll(":scope > .day-col")];
      if (!panes.length) return;
      const near = panes.reduce((b, p) => Math.abs(p.offsetLeft - cols.scrollLeft) < Math.abs(b.offsetLeft - cols.scrollLeft) ? p : b);
      if (near.dataset.date !== this._date && Math.abs(near.offsetLeft - cols.scrollLeft) < 4) this._landOn(body, cols, near.dataset.date);
    };
    // The axis is decided here, once per gesture: mostly-sideways drives the strip by hand, anything else is
    // left to the day's own native up/down scroll (touch-action: pan-y), so the two can never fight.
    let x0 = 0, y0 = 0, s0 = 0, t0 = 0, mode = null, dx = 0;
    cols.addEventListener("touchstart", (e) => {
      this._touching = true;
      const field = e.target.closest("input, textarea");
      if (e.touches.length !== 1 || e.target.closest(".swipe-row, .list-panel, .isg")
          || (field && field === document.activeElement)) { mode = "no"; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; s0 = cols.scrollLeft; t0 = Date.now(); dx = 0; mode = null;
    }, { passive: true });
    cols.addEventListener("touchmove", (e) => {
      if (mode === "no") return;
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (mode === null) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        mode = Math.abs(mx) > Math.abs(my) * 1.5 ? "day" : "no";
        if (mode === "day") { this._stripBusy = true; cols.style.scrollSnapType = "none"; }
      }
      if (mode !== "day") return;
      dx = mx;
      cols.scrollLeft = s0 - dx;
    }, { passive: true });
    const end = () => {
      this._touching = false;
      if (mode !== "day") { mode = null; return; }
      mode = null;
      const panes = [...cols.querySelectorAll(":scope > .day-col")];
      const i = panes.findIndex(p => p.dataset.date === this._date);
      const fast = Math.abs(dx) / Math.max(1, Date.now() - t0) > 0.5;      // px per ms
      const far = Math.abs(dx) > Math.max(60, cols.offsetWidth * 0.2);
      const step = (far || fast) ? (dx < 0 ? 1 : -1) : 0;                   // finger left = next day
      const pane = panes[Math.min(panes.length - 1, Math.max(0, i + step))] || panes[i];
      if (!pane) { this._stripBusy = false; cols.style.scrollSnapType = ""; return; }
      cols.scrollTo({ left: pane.offsetLeft, behavior: "smooth" });
      const done = () => { cols.style.scrollSnapType = ""; this._stripBusy = false; settle(); };
      let fin = false;
      const once = () => { if (fin) return; fin = true; cols.removeEventListener("scrollend", once); done(); };
      cols.addEventListener("scrollend", once);
      setTimeout(once, 600);
    };
    cols.addEventListener("touchend", end, { passive: true });
    cols.addEventListener("touchcancel", end, { passive: true });
    cols.addEventListener("scroll", () => { this._lastScroll = Date.now(); clearTimeout(t); t = setTimeout(settle, 90); }, { passive: true });
    cols.addEventListener("scrollend", () => { clearTimeout(t); settle(); });
  },

  /* The strip came to rest on `date`: that is the day now. Shift the panes (no redraw of the day you are on). */
  _landOn(body, cols, date) {
    this.flush();
    this._date = date;
    this._baseWs = this._wkOf(date);
    this._merge();
    this._syncPanes(cols);
    const label = document.querySelector(".plan-date");
    if (label) label.textContent = _planFull(date);
    this._drawnFor = `${this._date}|false`;
    this._focusBand(false);
    this._prefetchWeeks(cols);
    clearTimeout(this._quietTimer);
    this._quietTimer = setTimeout(() => this.render(body, true), 1500);
  },

  /* Panes for yesterday, today, tomorrow of the day on screen: drop the rest, build what is missing,
   * keep the current one where it is. */
  _syncPanes(cols) {
    const want = this._stripDates();
    const have = new Map([...cols.querySelectorAll(":scope > .day-col")].map(c => [c.dataset.date, c]));
    have.forEach((el, d) => { if (!want.includes(d)) { el.remove(); have.delete(d); } });
    this._blocks = this._blocks.filter(b => want.includes(b.date));
    const before = this._blocks.length;
    want.forEach((d, i) => {
      if (have.has(d)) return;
      const holder = App.el(`<div class="day-col" data-date="${d}"></div>`);
      this._buildDay(d, holder, true, i, false);
      have.set(d, holder);
    });
    want.forEach(d => cols.appendChild(have.get(d)));
    // only re-centre when the panes moved under the scroll position: a neighbour appearing out of sight must not nudge the day
    const cur = cols.querySelector(`:scope > .day-col[data-date="${this._date}"]`);
    if (!cur || Math.abs(cur.offsetLeft - cols.scrollLeft) > 1) this._centerStrip(cols, false);
    const fresh = this._blocks.slice(before);
    if (fresh.length) this._statsFor(fresh);
    else this._paintDayTotals();
  },

  /* The weeks either side of the day on screen, fetched quietly so the strip has a neighbour on Saturday/Sunday too. */
  async _prefetchWeeks(cols) {
    const need = [...new Set([-1, 1].map(n => this._wkOf(_planShift(this._date, n))))].filter(w => !this._weeks[w]);
    if (!need.length) return;
    try {
      const got = await Promise.all(need.map(w => App.api(`/api/board?week=${w}`)));
      need.forEach((w, i) => { this._weeks[w] = got[i]; });
    } catch (e) { return; }
    if (!cols.isConnected) return;
    // a finger on the strip, or it still gliding: the neighbours join once it is at rest
    if (this._touching || Date.now() - (this._lastScroll || 0) < 300) { setTimeout(() => this._prefetchWeeks(cols), 400); return; }
    this._merge();
    this._syncPanes(cols);
  },

  async _statsFor(blocksList) {
    const blocks = {};
    blocksList.forEach(b => { blocks[b.key] = b.knownRows(); });
    try {
      const res = await App.api("/api/nutrition/preview-batch", { method: "POST", body: { blocks } });
      blocksList.forEach(b => { const p = res.blocks[b.key]; b.applyPreview(p && p.rows.length ? p : null); });
    } catch (e) { /* the numbers follow on the next change */ }
    this._paintDayTotals(true);
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
        <div class="split-handle" id="split-handle" title="Drag to resize the list"></div>
        <aside class="list-panel" id="list-panel"></aside>
      </div>
    `;

    const cols = body.querySelector("#plan-cols");
    let panel = body.querySelector("#list-panel");
    const reused = this._reusePanel || null;
    this._reusePanel = null;
    if (reused) { panel.replaceWith(reused); panel = reused; }            // the list stays put (and scrolled) between days
    this._wireSplit(body.querySelector("#split-handle"), panel);
    // The arithmetic that keeps seven columns and the docked list on a
    // 1366-wide screen with no sideways scroll, measured in the real shell:
    //   1366 - 250 (list) - 15 (scrollbar gutter) = 1101 usable
    //   7 x 144 + 6 x 10 (gap) + 28 (padding)     = 1096
    // 1fr spends anything wider on the columns. Change either number and
    // this has to be redone -- 146 used to fit exactly, until a slot with
    // two meals in it made the grid tall enough to want a scrollbar.
    cols.style.gridTemplateColumns = weekMode
      ? `repeat(${dates.length}, minmax(120px, 1fr))`
      : "minmax(0, 780px)";
    if (!weekMode && !this._strip()) this._wireDaySwipe(cols, body);
    this._wireDrag(cols);

    const strip = this._strip();
    this._stripOn = strip;
    cols.classList.toggle("strip", strip);
    if (strip) { cols.style.gridTemplateColumns = "none"; this._wireStrip(cols, body); }
    const shown = strip ? this._stripDates() : dates;
    shown.forEach((date, ci) => {
      const flow = weekMode || strip;
      const holder = flow ? App.el(`<div class="day-col" data-date="${date}" ${weekMode ? `style="grid-column:${ci + 1};"` : ""}></div>`) : cols;
      if (flow) cols.appendChild(holder);
      this._buildDay(date, holder, flow, ci, weekMode);
    });
    if (strip) { this._centerStrip(cols, false); setTimeout(() => this._prefetchWeeks(cols), 400); }

    this._paintPick();
    this._drawNav();
    this.refreshSources();
    if (!reused) App.groceriesPanel.mount(body.querySelector("#list-panel"), this._listWeek,
      (n) => this._setBadge(n), "Next week", _planRange(this._listWeek, _planShift(this._listWeek, 6)), this._marketWeek);
    this._paintDayTotals(true);          // blocks already carry their last numbers: the bars are in this frame
    this._refreshAllStats();

    if (!this._isWeekMode()) {
      this._band = _currentBand();
      this._focusBand(false);
      this._bandTimer = setInterval(() => this._tickBand(), 60000);
    }
  },

  /* The divider between the plan and the shopping list: drag to resize, the width is remembered. */
  _wireSplit(handle, panel) {
    const KEY = "meals.v1.split";
    const clamp = (w) => Math.max(200, Math.min(Math.round(window.innerWidth * 0.6), w));
    try { const saved = Number(localStorage.getItem(KEY)); if (saved) panel.style.width = clamp(saved) + "px"; } catch (e) {}
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("drag");
      const move = (ev) => { panel.style.width = clamp(window.innerWidth - ev.clientX) + "px"; };
      const up = () => {
        handle.classList.remove("drag");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        try { localStorage.setItem(KEY, String(panel.offsetWidth)); } catch (err) {}
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
    handle.addEventListener("dblclick", () => {
      panel.style.width = "";
      try { localStorage.removeItem(KEY); } catch (e) {}
    });
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
      <button class="icon-btn" id="plan-prev" title="${weekMode ? "Back 7 days" : "Previous day"}">${App.icon('<path d="m15 18-6-6 6-6"/>')}</button>
      <div class="plan-date">${label}</div>
      <button class="icon-btn" id="plan-next" title="${weekMode ? "Forward 7 days" : "Next day"}">${App.icon('<path d="m9 18 6-6-6-6"/>')}</button>
      <button class="icon-btn" id="plan-import" title="Recipes from notes">${App.icon('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/><path d="M12 12v5M9.5 14.5 12 17l2.5-2.5"/>')}</button>
      <button class="btn-ghost btn-mini" id="plan-today">${weekMode ? "Today" : "Today"}</button>
      <div class="seg seg-mini" id="plan-mode">
        <button data-mode="" class="${!this._forceMode ? "active" : ""}">Auto</button>
        <button data-mode="week" class="${this._forceMode === "week" ? "active" : ""}">Week</button>
        <button data-mode="day" class="${this._forceMode === "day" ? "active" : ""}">Day</button>
      </div>
    `);
    const body = document.getElementById("body");
    const step = weekMode ? 7 : 1;
    const go = (n) => { if (weekMode) { this._date = _planShift(this._date, n); this.render(body); } else this._glide(body, n); };
    nav.querySelector("#plan-prev").addEventListener("click", () => go(-step));
    nav.querySelector("#plan-next").addEventListener("click", () => go(step));
    nav.querySelector("#plan-import").addEventListener("click", () => App.recipes.openImportFrom(() => this.render(body)));
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
    const before = JSON.stringify(this._blocks.map(b => b.totals));
    this._blocks.forEach(b => {
      const p = res.blocks[b.key];
      b.applyPreview(p && p.rows.length ? p : null);
    });
    // (already painted from each block's last numbers? only repaint when the answer differs)
    if (before !== JSON.stringify(this._blocks.map(b => b.totals)) || !this._barsPainted) this._paintDayTotals(true);
    this._barsPainted = true;
  },

  /* Calories, protein and fiber against each person's own target, at the end of the row of progress bars: one thin track per person.
   * Green once the target is reached; calories turn red a good way past it. (Targets: household members.) */
  _paintBars(foot, perPerson, people) {
    if (perPerson) {
      const rows = [["calories_kcal", "kcal", "kcal"], ["protein_g", "protein", "g protein"], ["fiber_g", "fiber", "g fiber"]];
      foot._barsHtml = rows.map(([key, tag, unit]) => {
        const per = perPerson.map((t, i) => {
          const goal = people && people[i] && people[i].targets ? people[i].targets[key] : 0;
          const pct = goal ? Math.round(100 * t[key] / goal) : null;
          const cls = pct >= 100 ? (key === "calories_kcal" && pct > 125 ? " over" : " done") : "";
          return { pct, cls, tip: `${t.name ? t.name + ": " : ""}${Math.round(t[key])} of ${goal || "?"} ${unit}` };
        });
        const nums = per.filter(x => x.pct !== null).map(x => x.pct).join(" · ");
        return `<span class="db-chip" title="${App.esc(per.map(x => x.tip).join("\n"))}"><span>${tag}</span><span class="db-bar">${per.map(x => `<b><i class="${x.cls}" style="width:${Math.min(100, x.pct || 0)}%"></i></b>`).join("")}</span><span class="num">${nums ? nums + "%" : ""}</span></span>`;
      }).join("");
    } else foot._barsHtml = "";
    this._placeBars(foot);
  },

  /* They go on the end of the gaps row (choline, iron … then kcal, protein, fiber) when that row is showing,
   * else on a row of their own. */
  _placeBars(foot) {
    foot.querySelectorAll(".dg-lows .db-chip").forEach(e => e.remove());
    const own = foot.querySelector(".day-bars"), lows = foot.querySelector(".day-gaps:not([hidden]) .dg-lows");
    const html = foot._barsHtml || "";
    if (lows && html) { lows.insertAdjacentHTML("beforeend", html); own.hidden = true; own.innerHTML = ""; return; }
    own.innerHTML = html; own.hidden = !html;
  },

  _paintDayTotals(now) {
    const days = {};
    document.querySelectorAll(".day-col-foot").forEach(foot => {
      const date = foot.dataset.date;
      const mine = this._blocks.filter(b => b.date === date && b.totals);
      const v = foot.querySelector(".v");
      if (mine.length === 0) { v.textContent = "—"; v.title = ""; this._paintBars(foot, null); this._paintGaps(foot, null); return; }
      // per PERSON, like each meal's header: one portion (the pot over its count) of every meal
      // that person eats -- household.portion on the server
      const people = (this._members || []).filter(m => m.active !== false);
      const eatsOf = (b) => { const e = b.eaters(); return e && e.length ? e : people.map(m => m.id); };
      const perPerson = (people.length ? people : [{ id: "_", name: "" }]).map(m => {
        const sum = { calories_kcal: 0, protein_g: 0, fiber_g: 0 };
        mine.forEach(b => {
          const ids = people.length ? eatsOf(b) : ["_"];
          if (!ids.includes(m.id)) return;
          const n = b.portions() || ids.length;
          for (const k of Object.keys(sum)) sum[k] += (b.totals[k] || 0) / n;
        });
        return { name: m.name, ...sum };
      });
      const line = (t) => `${Math.round(t.calories_kcal).toLocaleString()} kcal · ${t.protein_g.toFixed(0)}g P · ${t.fiber_g.toFixed(0)}g F`;
      const same = perPerson.every(t => Math.round(t.calories_kcal) === Math.round(perPerson[0].calories_kcal));
      v.textContent = same ? line(perPerson[0])
        : perPerson.map(t => `${t.name} ${Math.round(t.calories_kcal).toLocaleString()}`).join(" · ") + " kcal";
      v.title = perPerson.map(t => `${t.name ? t.name + ": " : "Each: "}${Math.round(t.calories_kcal)} kcal · ${t.protein_g.toFixed(1)} g protein · ${t.fiber_g.toFixed(1)} g fiber`).join("\n");
      this._paintBars(foot, perPerson, people);
      days[date] = { meals: mine.map(b => ({ totals: b.totals, eaters: b.eaters(), servings: b.portions() })), ingredient_ids: [...new Set(mine.flatMap(b => b.knownRows().map(r => r.ingredient_id)))] };
    });
    clearTimeout(this._gapsTimer);
    this._gapsTimer = setTimeout(() => this._refreshGaps(days), now ? 0 : 400);
  },

  /* What the day is low in, and whole foods that would fill it (gaps.py): the foot gets a
   * "low" chip; tapping it opens the list -- already open on a single day. */
  async _refreshGaps(days) {
    if (!Object.keys(days).length) return;
    const seq = this._gapsSeq = (this._gapsSeq || 0) + 1;
    // the last answer for these very numbers goes up at once; the fresh one only repaints what differs
    const gsig = JSON.stringify(days);
    const mem = this._gapsMem = this._gapsMem || {};
    let ls = {};
    try { ls = JSON.parse(localStorage.getItem("meals.v1.gaps") || "{}"); } catch (e) {}
    const hit = mem[gsig] || ls[gsig];
    if (hit) this._applyGaps(hit);
    let res;
    try { res = await App.api("/api/nutrition/gaps", { method: "POST", body: { days } }); }
    catch (e) { return; }
    mem[gsig] = res;
    try { delete ls[gsig]; ls[gsig] = res; Object.keys(ls).slice(0, -6).forEach(k => delete ls[k]); localStorage.setItem("meals.v1.gaps", JSON.stringify(ls)); } catch (e) {}
    if (seq !== this._gapsSeq) return;      // a later edit's answer is on its way
    this._applyGaps(res);
  },

  _applyGaps(res) {
    document.querySelectorAll(".day-col-foot").forEach(foot => {
      const d = res.days[foot.dataset.date];
      if (d) this._paintGaps(foot, d);
    });
    document.querySelectorAll(".side-strip").forEach(strip => {
      const d = res.days[strip.dataset.date];
      const list = d ? d.sides || [] : [];
      if (d) this._rememberSides(strip.dataset.date, list);
      const sig = JSON.stringify(list);
      if (strip._sig !== sig) this._paintSides(strip, list);      // (same ideas already showing: leave them be)
      // a side that was still drawing when the ideas were painted: fold them away now
      if (!strip.hidden && this._dinnerHasSide(strip.dataset.date, strip.parentNode)) this._syncSides(strip.dataset.date);
    });
  },

  /* The ideas last shown for a date's dinner main, kept in localStorage so they are there the instant the day draws
   * (the numbers behind them take a moment, longer on the phone). Only used while the main is the same one. */
  _mainOf(date) {
    const s = this._week && this._week.slots ? this._week.slots[`${date}:dinner`] : null;
    return s ? s.recipe_id : null;
  },
  _cachedSides(date) {
    try {
      const all = JSON.parse(localStorage.getItem("meals.v1.sides") || "{}");
      const e = all[date], main = this._mainOf(date);
      return e && main && e.main === main ? e.list : [];
    } catch (err) { return []; }
  },
  _rememberSides(date, list) {
    try {
      const main = this._mainOf(date);
      if (!main) return;
      const all = JSON.parse(localStorage.getItem("meals.v1.sides") || "{}");
      all[date] = { main, list };
      Object.keys(all).sort().slice(0, -30).forEach(k => delete all[k]);
      localStorage.setItem("meals.v1.sides", JSON.stringify(all));
    } catch (err) {}
  },

  /* Side ideas under a lone dinner main (sides.py): what the day is low in, and what we usually eat
   * with this main, learned from past plans. + puts it in as the dinner's next block; x says not
   * with this main for a few weeks. Gone once the dinner has a side. */
  /* The ideas fold away smoothly (CSS .leaving), resolving when the fold is done. */
  _leaveStrip(strip) {
    strip.classList.add("leaving");
    return new Promise(r => setTimeout(() => { strip.hidden = true; strip.innerHTML = ""; strip.classList.remove("leaving"); r(); }, 280));
  },

  /* A dinner has a side once an extra block is named (or saved); an empty extra block doesn't count, nor does a removed one. */
  _dinnerHasSide(date, cell) {
    const saved = this._indicesFor(date, "dinner").length > 1;
    if (!cell) return saved;
    const extras = Array.from(cell.querySelectorAll(".mb")).slice(1);
    const named = extras.some(el => el.querySelector(".mb-name").value.trim());
    // a block still drawing has an empty name box but a saved slot; only someone typing in an extra block makes the box the truth
    const typing = extras.some(el => el.contains(document.activeElement) && document.activeElement.classList.contains("mb-name"));
    return typing ? named : (named || saved);
  },

  /* Keep the ideas in step with the dinner: a side named or added -> they fold away and the line + appears under it;
   * the side removed or left blank -> they come back. */
  _syncSides(date) {
    if (this._isWeekMode()) return;
    const cell = document.querySelector(`.meal-cell[data-date="${date}"][data-meal="dinner"]`);
    const strip = cell && cell.querySelector(".side-strip");
    if (!strip) return;
    const has = this._dinnerHasSide(date, cell);
    cell.classList.toggle("has-side", has);
    if (has) { if (!strip.hidden && !strip.classList.contains("leaving")) this._leaveStrip(strip); return; }
    if (!strip.hidden || strip.classList.contains("leaving")) return;
    this._paintSides(strip, this._cachedSides(date));
    strip.classList.add("entering");
    requestAnimationFrame(() => requestAnimationFrame(() => strip.classList.remove("entering")));
    this._paintDayTotals(true);                 // and fresh ideas for what the day is now
  },

  _paintSides(strip, list) {
    strip._sig = JSON.stringify(list);
    strip.innerHTML = "";
    // once the dinner has a side (or a new block is open) the ideas are done: the line + under the last block adds more
    if (this._dinnerHasSide(strip.dataset.date, strip.parentNode)) { strip.hidden = true; return; }
    // day view: the ideas always end in a blank + = another dinner block (the plus that used to sit under dinner)
    const dayView = !this._isWeekMode();
    strip.hidden = !list.length && !dayView;
    const date = strip.dataset.date;
    const blank = () => {
      const b = App.el(`<button class="ss-blank" title="Add another dinner block">${App.icon(GP_PLUS)}</button>`);
      b.addEventListener("click", () => {
        const cell = strip.parentNode;
        const empty = Array.from(cell.querySelectorAll(".mb")).slice(1).find(el => !el.querySelector(".mb-name").value.trim());
        if (empty) { empty.querySelector(".mb-name").focus(); return; }       // one is already waiting
        const add = cell.querySelector(".meal-add");
        if (add) add.click();          // a new empty block; the ideas stay until it is named
      });
      strip.appendChild(b);
    };
    if (!list.length) { if (dayView) blank(); return; }
    const why = (s) => s.why.kind === "pair" ? `Went with ${s.why.main} ${s.why.n}×`
      : s.why.kind === "like" ? `Went with ${s.why.main}, a similar meal`
      : s.why.kind === "usual" ? "A usual side" : "Fills what's low";
    const helps = (s) => s.helps.map(h => `+${h.amount}${h.unit === "g" ? "g" : " " + h.unit} ${h.label}`).join(" · ");
    strip.appendChild(App.el(`<div class="ss-head" title="Sides that fit this dinner">${App.icon(GP_SIDE)}</div>`));
    list.forEach(s => {
      const key = s.kind === "recipe" ? "r:" + s.recipe_id : "f:" + s.name.toLowerCase();
      const row = App.el(`
        <div class="ss-row${s.learned ? " learned" : ""}" title="${App.esc(why(s))}${s.kind === "food" && s.buy ? " · not bought yet" : ""}${s.helps.length ? "\n" + App.esc(helps(s)) : ""}">
          <button class="icon-btn ss-add" title="Add as a side">${App.icon(GP_PLUS)}</button>
          <span class="ss-name">${App.esc(s.name)}</span>
          ${s.learned ? `<span class="ss-mark">${App.icon(GP_USUAL)}</span>` : ""}
          ${s.kind === "food" ? `<span class="ss-por num">${App.esc(s.portion)}</span>` : ""}
          <span class="ss-helps num">${App.esc(helps(s))}</span>
          <button class="icon-btn ss-no" title="Not with this">${App.icon(GP_X)}</button>
        </div>`);
      // the whole row is the button: tap anywhere on it (not the x) to add the side
      const addBtn = row.querySelector(".ss-add");
      const add = async () => {
        if (addBtn.disabled) return;
        addBtn.disabled = true;
        const folded = this._leaveStrip(strip);
        try {
          await Promise.all(this._blocks.map(x => x.flush()));
          await App.api("/api/sides/accept", { method: "POST", body: s.kind === "recipe"
            ? { date, recipe_id: s.recipe_id } : { date, name: s.name, grams: s.grams } });
          await folded;
          await this.render(document.getElementById("body"));
        } catch (e) { addBtn.disabled = false; App.toast(`Couldn't add ${s.name}`); }
      };
      row.addEventListener("click", (ev) => { if (!ev.target.closest(".ss-no")) add(); });
      // swipe it away on the phone (the x is only for a mouse), or click the x
      const dismiss = async () => {
        (wrap.isConnected ? wrap : row).remove();
        if (!strip.querySelector(".ss-row")) strip.hidden = true;
        try { await App.api("/api/sides/dismiss", { method: "POST", body: { date, side_key: key } }); } catch (e) { return; }
        this._rememberSides(date, list.filter(x => x !== s));
        App.undoToast(`${s.name} hidden`, async () => {
          await App.api("/api/sides/undismiss", { method: "POST", body: { date, side_key: key } });
          this._gapsSeq = (this._gapsSeq || 0) + 1; this._paintDayTotals();
        });
      };
      row.querySelector(".ss-no").addEventListener("click", dismiss);
      const wrap = App.swipeAway(row, dismiss);
      strip.appendChild(wrap);
    });
    if (dayView) blank();
  },

  _paintGaps(foot, day) {
    const chip = foot.querySelector(".day-low"), box = foot.querySelector(".day-gaps");
    if (!chip) return;
    const gsig = JSON.stringify(day);
    if (foot._gapsSig === gsig) return;          // the same answer is already up: nothing moves
    foot._gapsSig = gsig;
    if (!day || !day.judged || !day.low.length) {
      chip.hidden = true; box.hidden = true; box.innerHTML = "";
      if (day && day.judged) { chip.hidden = false; chip.className = "day-low ok"; chip.innerHTML = `${App.icon('<path d="M20 6 9 17l-5-5"/>')}`; chip.title = "Nothing low today"; }
      this._placeBars(foot);
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
    // tap a low nutrient to see more of what fills it; tap it again to go back
    const paintList = (key) => {
      const set = key && day.focus && day.focus[key] ? day.focus[key] : day;
      const have = set.have, buy = set.buy;
      box.querySelectorAll(".dg-low").forEach(el => el.classList.toggle("sel", el.dataset.key === key));
      box.querySelector(".dg-list").innerHTML = `
        ${have.length ? `<div class="dg-head">${App.icon(GP_PANTRY)}<span>Already buy</span></div>${have.map(c => row(c, "have")).join("")}` : ""}
        ${buy.length ? `<div class="dg-head">${App.icon(GP_CART)}<span>Could buy</span></div>${buy.map(c => row(c, "buy")).join("")}` : ""}`;
      wireBuy();
    };
    box.innerHTML = `
      <div class="dg-lows">${day.low.map(l => `
        <span class="dg-low" data-key="${App.esc(l.key)}" title="${l.have} of ${l.target} ${l.unit}${App.esc(whoText(l))} — tap for more that fill it"><span>${App.esc(l.label)}${l.who && l.who.length ? ` <span class="dg-who">${App.esc(l.who.join(", "))}</span>` : ""}</span><span class="dg-bar"><i style="width:${Math.min(100, l.pct)}%"></i></span><span class="num">${l.pct}%</span></span>`).join("")}</div>
      <div class="dg-list"></div>`;
    this._placeBars(foot);
    let picked = null;
    box.querySelectorAll(".dg-low").forEach(el => el.addEventListener("click", () => {
      picked = picked === el.dataset.key ? null : el.dataset.key;
      paintList(picked);
    }));
    const wireBuy = () => {
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
    };
    paintList(null);
    const date = foot.dataset.date;
    this._gapsOpen = this._gapsOpen || {};
    const open = this._gapsOpen[date] ?? !this._isWeekMode();
    box.hidden = !open;
    foot.classList.toggle("gaps-open", open);
    this._placeBars(foot);
    if (!chip._wired) {
      chip._wired = true;
      chip.addEventListener("click", () => {
        if (chip.classList.contains("ok")) return;
        this._gapsOpen[foot.dataset.date] = box.hidden;
        box.hidden = !box.hidden;
        foot.classList.toggle("gaps-open", !box.hidden);
        this._placeBars(foot);
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
