/* The ingredient popout: tap a meal line's kcal number -> its full Nutrition Facts label, one
 * portion by default (toggle: the whole line / per 100 g), a % bar for each person against their own
 * target, and the absorption pairings about this food (pairings.py -- code decides every state).
 * One shared element: a card by the row on the laptop, a bottom sheet on the phone (style.css). */
App.nutPop = (() => {
  const GROUPS = [["main", ""], ["fat", "Fats"], ["carbs", "Carbs"], ["vitamins", "Vitamins"], ["minerals", "Minerals"]];
  const KIND = {
    met: ['<path d="m5 12 5 5L20 7"/>', "Already in the meal"],
    missing: ['<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>', "Missing from the meal"],
    blocked: ['<path d="M12 4 3 20h18L12 4zM12 10v4M12 17v.01"/>', "Something in the meal works against it"],
    tip: ['<path d="M12 8v.01M11 12h1v5h1"/><circle cx="12" cy="12" r="9"/>', "Good to know"],
  };
  const CHEV = '<path d="m9 6 6 6-6 6"/>';
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem("meals.v1.np." + k)) ?? d; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem("meals.v1.np." + k, JSON.stringify(v)); } catch (e) {} };

  let el = null, seq = 0, data = null, mode = lsGet("mode", "portion"), groups = lsGet("groups", {});
  let anchor = null;

  const close = () => {
    seq++;
    if (el) { el.remove(); el = null; }
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", place);
  };
  const outside = (e) => { if (el && !el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(); };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };

  const num = (v) => (v >= 1000 ? Math.round(v).toLocaleString() : v);
  const initials = (n) => (n || "?").trim().charAt(0).toUpperCase();

  function place() {
    if (!el || !anchor || window.matchMedia("(max-width: 760px)").matches) { if (el) { el.style.left = el.style.top = ""; } return; }
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    let left = Math.min(r.right - w, window.innerWidth - w - 8);
    left = Math.max(8, left);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
    el.style.left = left + "px"; el.style.top = top + "px";
  }

  const bar = (p, kind) => {
    const w = Math.max(0, Math.min(100, p.pct));
    const tone = kind === "limit" ? (p.pct > 100 ? "bad" : p.pct > 70 ? "warn" : "ok") : "ok";
    return `<span class="np-bar ${tone} ${kind}" title="${App.esc(p.name)} ${p.pct}%"><i style="width:${w}%"></i></span>`;
  };

  function paint() {
    if (!el) return;
    const d = data;
    if (!d) { el.querySelector(".np-body").innerHTML = '<div class="np-wait">…</div>'; return; }
    const people = d.people || [];
    const amt = (r) => r.known ? `${num(mode === "line" ? r.line : mode === "per100" ? r.per100 : r.portion)}${r.unit === "kcal" ? "" : " " + r.unit}` : "—";
    const head = `
      <div class="np-head">
        <div class="np-title"><b>${App.esc(d.name)}</b><span class="np-amt">${App.esc(d.amountText || "")} · ${d.grams} g</span></div>
        <div class="np-seg" role="tablist">
          ${[["portion", "1×", d.portions > 1 ? `One portion (the pot ÷ ${d.portions})` : "One portion"], ["line", "line", "The whole line"], ["per100", "100 g", "Per 100 g"]]
            .map(([k, t, tip]) => `<button data-mode="${k}" title="${tip}" class="${mode === k ? "on" : ""}">${t}</button>`).join("")}
        </div>
      </div>
      ${d.description ? `<div class="np-usda">${App.esc(d.description)}</div>` : ""}`;
    const pairs = (d.pairings || []).map((p, i) => `
      <div class="np-pair ${p.kind}" data-i="${i}">
        <button class="np-pair-line" title="${KIND[p.kind][1]}">${App.icon(KIND[p.kind][0])}<span>${App.esc(p.line)}${p.helpers && p.helpers.length ? ` <i>· ${App.esc(p.helpers.join(", "))}</i>` : ""}</span>${App.icon(CHEV)}</button>
        <div class="np-pair-detail">${App.esc(p.detail)}</div>
      </div>`).join("");
    const cols = people.length && mode !== "per100" ? people.map(p => `<span class="np-ini" title="${App.esc(p.name)}">${initials(p.name)}</span>`).join("") : "";
    const sections = GROUPS.map(([g, title]) => {
      const rows = d.rows.filter(r => r.group === g && r.known);      // what USDA doesn't list stays out (counted below)
      if (!rows.length) return "";
      const open = groups[g] !== false;
      const body = (open || g === "main" ? rows : []).map(r => {
        const bars = r.known && r.pct && mode !== "per100" ? r.pct.map(p => bar(p, r.kind)).join("") : "";
        return `<div class="np-row ind${r.indent} ${r.known ? "" : "unk"}"><span class="np-n">${App.esc(r.label)}</span><span class="np-v num">${amt(r)}</span><span class="np-bars">${bars}</span></div>`;
      }).join("");
      return `<div class="np-grp ${open ? "open" : ""}" data-g="${g}">${title ? `<button class="np-grp-h">${App.icon(CHEV)}<span>${title}</span></button>` : ""}<div class="np-grp-b">${body}</div></div>`;
    }).join("");
    el.querySelector(".np-body").innerHTML = `${head}
      ${pairs ? `<div class="np-pairs">${pairs}</div>` : ""}
      <div class="np-cols"><span></span><span></span><span class="np-inis">${cols}</span></div>
      <div class="np-label">${sections}</div>
      ${d.rows.some(r => !r.known) ? `<div class="np-unk" title="${App.esc(d.rows.filter(r => !r.known).map(r => r.label).join(", "))}">${d.rows.filter(r => !r.known).length} not listed by USDA</div>` : ""}`;
    el.querySelectorAll(".np-seg button").forEach(b => b.addEventListener("click", () => { mode = b.dataset.mode; lsSet("mode", mode); paint(); place(); }));
    el.querySelectorAll(".np-pair-line").forEach(b => b.addEventListener("click", () => { b.parentNode.classList.toggle("open"); place(); }));
    el.querySelectorAll(".np-grp-h").forEach(b => b.addEventListener("click", () => {
      const g = b.parentNode.dataset.g; groups[g] = groups[g] === false; lsSet("groups", groups); paint(); place();
    }));
    place();
  }

  async function open(anchorEl, ctx) {
    close();
    anchor = anchorEl;
    el = App.el(`<div class="np" role="dialog" aria-label="Nutrition"><div class="np-pull"></div><button class="icon-btn np-x" title="Close">${App.icon('<path d="M18 6 6 18M6 6l12 12"/>')}</button><div class="np-body"></div></div>`);
    document.body.appendChild(el);
    data = null; paint();
    el.querySelector(".np-x").addEventListener("click", close);
    // swipe down on the sheet's top edge closes it (phone)
    const pull = el.querySelector(".np-pull"); let y0 = null;
    pull.addEventListener("touchstart", (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    pull.addEventListener("touchmove", (e) => { if (y0 !== null && e.touches[0].clientY - y0 > 40) { y0 = null; close(); } }, { passive: true });
    setTimeout(() => {
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", place);
    }, 0);
    const my = ++seq;
    try {
      const res = await App.api("/api/nutrition/line", { method: "POST", body: {
        ingredient_id: ctx.ingredient_id, qty: ctx.qty, unit: ctx.unit,
        eaters: ctx.eaters || null, servings: ctx.servings || null, meal_lines: ctx.meal_lines || [] } });
      if (my !== seq || !el) return;           // closed, or another line was opened since
      res.amountText = ctx.amountText || "";
      data = res; paint();
    } catch (err) {
      if (my !== seq || !el) return;
      el.querySelector(".np-body").innerHTML = `<div class="np-wait">${App.esc(err.message || "No nutrition for this line")}</div>`;
    }
  }

  return { open, close };
})();
