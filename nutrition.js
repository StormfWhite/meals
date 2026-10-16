/* Nutrition dashboard — day/week totals are shared across the household
 * (see nutrition.py's docstring: no per-member meal assignment exists, so
 * "a person's nutrition" means one serving of whatever's on the board).
 * What differs per person is only their targets, so "All" shows the
 * shared totals plus a compact per-member status list, while picking one
 * member expands into full stat tiles + a vitamins row against their
 * targets specifically. */
window.App = window.App || {};

const STATUS_LABEL = { under: "under", on: "on target", over: "over", way_over: "well over" };
const STATUS_CLASS = { under: "", on: "good", over: "warn", way_over: "bad" };

App.nutrition = {
  _members: [],
  _person: "all",
  _mode: "day",
  _date: new Date().toISOString().slice(0, 10),
  _weekStart: null,

  async render(body) {
    body.innerHTML = `<div class="pad"><div class="loading-state"><div class="spin"></div>Loading…</div></div>`;
    const membersRes = await App.api("/api/household/members");
    this._members = membersRes.members.filter(m => m.active);
    if (!this._weekStart) {
      const board = await App.api("/api/board");
      this._weekStart = board.week_start;
    }
    await this._draw(body);
  },

  async _draw(body) {
    const params = this._mode === "day" ? `date=${this._date}` : `week=${this._weekStart}`;
    const memberParam = this._person !== "all" ? `&member_id=${this._person}` : "";
    let data;
    try {
      data = await App.api(`/api/nutrition/${this._mode}?${params}${memberParam}`);
    } catch (e) {
      body.innerHTML = `<div class="notice bad">${_esc(e.message)}</div>`;
      return;
    }

    body.innerHTML = `
      <div class="board-toolbar">
        <div class="seg" id="mode-seg">
          <button data-mode="day" class="${this._mode === "day" ? "active" : ""}">Day</button>
          <button data-mode="week" class="${this._mode === "week" ? "active" : ""}">Week</button>
        </div>
        <button class="icon-btn" id="prev-btn">${App.icon('<path d="m15 18-6-6 6-6"/>')}</button>
        <div class="field-label" style="min-width:140px;">${this._mode === "day" ? _fmtFull(this._date) : _fmtRange(this._weekStart)}</div>
        <button class="icon-btn" id="next-btn">${App.icon('<path d="m9 18 6-6-6-6"/>')}</button>
        <div class="spacer"></div>
        <div class="seg" id="person-seg">
          <button data-person="all" class="${this._person === "all" ? "active" : ""}">All</button>
          ${this._members.map(m => `<button data-person="${m.id}" class="${this._person === m.id ? "active" : ""}">${_esc(m.name)}</button>`).join("")}
        </div>
      </div>
      <div class="pad" id="nutrition-body"></div>
    `;

    const out = body.querySelector("#nutrition-body");
    if (this._members.length === 0) {
      out.innerHTML = `<div class="empty-state">${App.icon('<circle cx="12" cy="12" r="9"/>')}<div>Add household members in Settings to see targets here.</div></div>`;
    } else if (this._person === "all") {
      out.appendChild(this._sharedTotals(data.totals || data.total));
      out.appendChild(this._memberList(data.members));
    } else {
      out.appendChild(this._memberDetail(data));
    }

    body.querySelector("#mode-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      this._mode = btn.dataset.mode;
      this._draw(body);
    });
    body.querySelector("#person-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button"); if (!btn) return;
      this._person = btn.dataset.person;
      this._draw(body);
    });
    body.querySelector("#prev-btn").addEventListener("click", () => { this._shift(-1); this._draw(body); });
    body.querySelector("#next-btn").addEventListener("click", () => { this._shift(1); this._draw(body); });
  },

  _shift(dir) {
    if (this._mode === "day") {
      const d = new Date(this._date + "T00:00:00");
      d.setDate(d.getDate() + dir);
      this._date = d.toISOString().slice(0, 10);
    } else {
      const d = new Date(this._weekStart + "T00:00:00");
      d.setDate(d.getDate() + dir * 7);
      this._weekStart = d.toISOString().slice(0, 10);
    }
  },

  _sharedTotals(totals) {
    return App.el(`<div class="stat-grid" style="margin-bottom:12px;">
      <div class="stat"><div class="k">Calories</div><div class="v num">${Math.round(totals.calories_kcal)}</div></div>
      <div class="stat"><div class="k">Protein</div><div class="v num">${totals.protein_g.toFixed(1)}g</div></div>
      <div class="stat"><div class="k">Fiber</div><div class="v num">${totals.fiber_g.toFixed(1)}g</div></div>
    </div>`);
  },

  _memberList(members) {
    const wrap = App.el(`<div style="display:flex;flex-direction:column;gap:6px;"></div>`);
    members.forEach(m => {
      wrap.appendChild(App.el(`<div class="item-row">
        <span class="name">${_esc(m.member.name)}</span>
        <span class="meta">
          cal ${STATUS_LABEL[m.status.calories_kcal]} ·
          protein ${STATUS_LABEL[m.status.protein_g]} ·
          fiber ${STATUS_LABEL[m.status.fiber_g]}
        </span>
      </div>`));
    });
    return wrap;
  },

  _memberDetail(data) {
    const t = data.totals, targets = data.member.targets, status = data.status;
    const wrap = App.el(`<div></div>`);
    wrap.appendChild(App.el(`<div class="stat-grid" style="margin-bottom:14px;">
      ${this._statTile("Calories", t.calories_kcal, targets.calories_kcal, status.calories_kcal, "")}
      ${this._statTile("Protein", t.protein_g, targets.protein_g, status.protein_g, "g")}
      ${this._statTile("Fiber", t.fiber_g, targets.fiber_g, status.fiber_g, "g")}
    </div>`));

    const vitaminKeys = Object.keys(targets.vitamins || {});
    if (vitaminKeys.length) {
      const grid = App.el(`<div class="stat-grid"></div>`);
      vitaminKeys.forEach(k => {
        const actual = (t.vitamins || {})[k] || 0;
        const target = targets.vitamins[k];
        const st = status.vitamins[k] || "on";
        grid.appendChild(App.el(this._statTile(_vitaminLabel(k), actual, target, st, "")));
      });
      wrap.appendChild(App.el(`<div class="field-label" style="margin-bottom:6px;">Vitamins &amp; minerals</div>`));
      wrap.appendChild(grid);
    }
    return wrap;
  },

  _statTile(label, actual, target, status, unit) {
    const cls = STATUS_CLASS[status] || "";
    return `<div class="stat ${cls}">
      <div class="k">${label}</div>
      <div class="v num">${_round1(actual)}${unit} <span class="dim" style="font-weight:400;font-size:11px;">/ ${_round1(target)}${unit}</span></div>
    </div>`;
  },
};

function _round1(n) { return Math.round(n * 10) / 10; }
function _vitaminLabel(key) {
  return key.replace(/_mg$|_mcg$/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}
function _fmtFull(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
function _fmtRange(weekStart) {
  const s = new Date(weekStart + "T00:00:00");
  const e = new Date(s); e.setDate(e.getDate() + 6);
  return `${s.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${e.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
function _esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
