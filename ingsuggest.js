/* The ingredient dropdown that learns.
 *
 * A native <datalist> can't do this: the browser filters and orders it
 * however it likes, so "c" offers cabbage before chicken forever, and it
 * has nowhere to put *why* a line is being offered. This is a small
 * combobox over /api/suggest/ingredients, which ranks the catalog by what
 * has actually been cooked (see mealplanner/suggest.py) -- how much a
 * thing gets used, whether it's a breakfast word, what it usually appears
 * beside, and how close this meal's name is to the meals it belongs to.
 *
 * It floats in `position: fixed` off document.body rather than inside the
 * row: the plan is a scrolling grid with narrow columns in week mode, and
 * anything absolutely positioned inside a cell gets clipped by it.
 *
 * The typed text is never overwritten by accident. The first row is
 * pre-highlighted only when something has been typed (an exact catalog
 * name always sorts first, so Tab completes rather than replaces); with an
 * empty box nothing is highlighted, so Tab just moves on. Callers ask for
 * `active()` before acting on a Tab -- see mealblock.js.
 */
window.App = window.App || {};

App.ingSuggest = {
  _el: null,
  _input: null,
  _opts: null,
  _items: [],
  _index: -1,
  _timer: null,
  _seq: 0,

  attach(input, opts) {
    input.addEventListener("focus", () => this._open(input, opts));
    input.addEventListener("input", () => this._open(input, opts));
    input.addEventListener("blur", () => setTimeout(() => { if (this._input === input) this.close(); }, 120));
    input.addEventListener("keydown", (e) => this._onKey(e, input, opts));
  },

  isOpen() { return !!this._el; },

  /* The row Tab/Enter would take, or null when the user hasn't chosen one
   * -- the caller must treat null as "keep what's typed". */
  active() {
    if (!this._el || this._index < 0) return null;
    return this._items[this._index] || null;
  },

  accept(item) {
    const input = this._input;
    const opts = this._opts;
    if (!input || !item) return;
    input.value = item.name;
    this.close();
    if (opts && opts.onPick) opts.onPick(item, input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },

  close() {
    if (this._el) this._el.remove();
    this._el = null;
    this._input = null;
    this._items = [];
    this._index = -1;
    clearTimeout(this._timer);
  },

  // ── fetching ────────────────────────────────────────────────────────
  _open(input, opts) {
    this._input = input;
    this._opts = opts;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._fetch(input, opts), 110);
  },

  async _fetch(input, opts) {
    if (document.activeElement !== input) return;
    if (opts.local) {
      // meal-name box: the list is already on the page, in learned order
      // (recency x frequency, see board.meal_options), so just filter it
      const t = input.value.trim().toLowerCase();
      const all = opts.local();
      const hits = t ? all.filter(o => o.name.toLowerCase().includes(t)) : all;
      this._items = hits.sort((a, b) => (b.name.toLowerCase().startsWith(t) ? 1 : 0) - (a.name.toLowerCase().startsWith(t) ? 1 : 0)).slice(0, 8);
      this._index = -1;   // a typed meal name is never replaced unless clicked
      this._draw(input);
      return;
    }
    const ctx = (opts.context && opts.context()) || {};
    const seq = ++this._seq;
    const params = new URLSearchParams({
      q: input.value.trim(),
      meal: ctx.meal || "",
      meal_name: ctx.meal_name || "",
      used: (ctx.used || []).join(","),
      // What's already on this week's two shopping lists ranks first: it's
      // the food that will actually be in the kitchen (see suggest.py).
      week: ctx.week || "",
      limit: "7",
    });
    let res;
    try { res = await App.api(`/api/suggest/ingredients?${params}`); }
    catch (err) { return; }
    if (seq !== this._seq || document.activeElement !== input) return;
    this._items = res.suggestions;
    // Typed something -> the top row is what Tab completes to. Empty box ->
    // the list is a menu to look at, not something Tab should commit.
    this._index = input.value.trim() && this._items.length ? 0 : -1;
    this._draw(input);
  },

  // ── drawing ─────────────────────────────────────────────────────────
  _draw(input) {
    if (!this._items.length) { this.close(); this._input = input; return; }
    if (!this._el) {
      this._el = App.el(`<div class="isg"></div>`);
      document.body.appendChild(this._el);
      this._el.addEventListener("mousedown", (e) => e.preventDefault());  // don't blur the input out from under the click
      this._el.addEventListener("click", (e) => {
        const x = e.target.closest(".isg-x");
        if (x) {
          const item = this._items[Number(x.parentElement.dataset.i)];
          const opts = this._opts;
          if (item && opts && opts.onDelete) {
            Promise.resolve(opts.onDelete(item)).then(() => {
              this._items = this._items.filter(i => i !== item);
              if (this._input) this._draw(this._input);
            });
          }
          return;
        }
        const row = e.target.closest(".isg-row");
        if (row) this.accept(this._items[Number(row.dataset.i)]);
      });
    }
    this._el.innerHTML = this._items.map((s, i) => `
      <div class="isg-row ${i === this._index ? "on" : ""} ${s.on_list ? "on-list" : ""}" data-i="${i}">
        <span class="isg-name">${App.esc(s.name)}</span>
        ${s.reason ? `<span class="isg-why">${App.esc(s.reason)}</span>` : ""}
        ${s.typical ? `<span class="isg-amt num">${App.esc(s.typical.label)}</span>` : ""}
        ${this._opts && this._opts.onDelete ? `<span class="isg-x" title="Remove from suggestions">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</span>` : ""}
      </div>`).join("");
    this._place(input);
  },

  _place(input) {
    const r = input.getBoundingClientRect();
    const el = this._el;
    el.style.minWidth = `${Math.max(r.width, 200)}px`;
    el.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
    const below = window.innerHeight - r.bottom;
    if (below < 150 && r.top > below) {
      el.style.top = "auto";
      el.style.bottom = `${window.innerHeight - r.top + 3}px`;
    } else {
      el.style.bottom = "auto";
      el.style.top = `${r.bottom + 3}px`;
    }
  },

  _move(delta) {
    const n = this._items.length;
    if (!n) return;
    this._index = this._index < 0 ? (delta > 0 ? 0 : n - 1) : (this._index + delta + n) % n;
    Array.from(this._el.children).forEach((row, i) => row.classList.toggle("on", i === this._index));
  },

  /* Only the keys that belong to the menu itself. Tab and Enter are the
   * caller's (mealblock.js walks the line with them) -- this listener sits
   * on the input, so it always runs before the row's, and the caller reads
   * `active()` to decide what a Tab means. */
  _onKey(e, input, opts) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!this._el) { this._open(input, opts); return; }
      e.preventDefault();
      this._move(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (this._el && e.key === "Escape") {
      // first Escape dismisses the menu; only a second one gets through to
      // end the line, so this must not bubble
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  },
};

window.addEventListener("resize", () => App.ingSuggest.close());
document.addEventListener("scroll", () => App.ingSuggest.close(), true);
