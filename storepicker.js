/* Picking a real shop by typing its name.
 *
 * The list comes from OpenStreetMap by way of the server, which fetches
 * every shop around the active place ONCE and then filters it locally —
 * so this types instantly and doesn't fire a request per keystroke. (It
 * also can't wander: a name-biased geocoder asked for "grocery" near
 * Raleigh will happily answer with Dubai. See places.py.)
 *
 * Same shape as ingsuggest.js: an input, a fixed-position menu hung off
 * <body> so a scrolling container can't clip it, arrows and Enter to
 * choose, Escape to give up.
 */
window.App = window.App || {};

App.storePicker = {
  _menu: null,
  _input: null,
  _items: [],
  _active: -1,
  _onPick: null,
  _timer: null,

  /* `anchor` is the element the menu hangs under — usually the button that
   * opened it, so the picker appears where the store name already is. */
  open(anchor, { kind = "grocery", current = null, onPick } = {}) {
    this.close();
    this._onPick = onPick;
    this._placeMode = false;
    this._kind = kind;
    const box = App.el(`
      <div class="sp-pop">
        <div class="sp-head">
          ${App.icon('<path d="M3 9h18l-1.5 11H4.5Z"/><path d="M8 9V6a4 4 0 0 1 8 0v3"/>')}
          <span>${kind === "market" ? "Farmer's market" : "Grocery store"}</span>
          <button class="icon-btn sp-refresh" title="Look again for shops nearby">${App.icon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>')}</button>
        </div>
        <input class="sp-input" placeholder="Type a store name…" spellcheck="false" autocomplete="off" value="${current ? App.esc(current.name) : ""}">
        <div class="sp-list"></div>
        <div class="sp-foot dim"></div>
      </div>
    `);
    document.body.appendChild(box);
    this._menu = box;
    this._input = box.querySelector(".sp-input");

    const rect = anchor.getBoundingClientRect();
    box.style.top = `${Math.min(rect.bottom + 4, window.innerHeight - 320)}px`;
    box.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 312))}px`;

    this._input.addEventListener("input", () => this._search(kind));
    this._input.addEventListener("keydown", (e) => this._key(e));
    box.querySelector(".sp-refresh").addEventListener("click", () => this._search(kind, true));
    setTimeout(() => { this._input.focus(); this._input.select(); }, 0);
    this._search(kind);

    this._away = (e) => { if (!box.contains(e.target)) this.close(); };
    setTimeout(() => document.addEventListener("mousedown", this._away), 0);
  },

  close() {
    if (this._away) document.removeEventListener("mousedown", this._away);
    if (this._menu) this._menu.remove();
    this._menu = null;
    this._items = [];
    this._active = -1;
  },

  async _search(kind, refresh = false) {
    const q = this._input.value.trim();
    const foot = this._menu.querySelector(".sp-foot");
    if (refresh) foot.textContent = "Looking for shops nearby…";

    // Nowhere to be near yet: the same box turns into "where do you live",
    // rather than sending you off to Settings to come back afterwards.
    if (this._placeMode) return this._searchPlaces(kind);

    let res;
    try {
      res = await App.api(`/api/stores/search?q=${encodeURIComponent(q)}&kind=${kind}${refresh ? "&refresh=true" : ""}`);
    } catch (err) {
      if (/place/i.test(err.message)) { this._enterPlaceMode(kind); return; }
      this._menu.querySelector(".sp-list").innerHTML =
        `<div class="sp-empty">${App.esc(err.message)}</div>`;
      foot.textContent = "";
      return;
    }
    this._items = res.results;
    this._active = this._items.length ? 0 : -1;
    foot.textContent = res.place ? `near ${res.place.label}` : "";
    this._draw();
  },

  _enterPlaceMode(kind) {
    this._placeMode = true;
    this._menu.querySelector(".sp-head span").textContent = "Where do you cook?";
    this._input.placeholder = "Your address, or the building…";
    this._input.value = "";
    this._menu.querySelector(".sp-foot").textContent = "a store list has to be near somewhere";
    this._menu.querySelector(".sp-list").innerHTML =
      `<div class="sp-empty">Type where you live, then pick your store.</div>`;
    this._input.focus();
  },

  async _searchPlaces(kind) {
    const q = this._input.value.trim();
    let res;
    try { res = await App.api(`/api/places/search?q=${encodeURIComponent(q)}`); }
    catch (err) { return; }
    this._items = res.results.map(p => ({ ...p, _place: true, distance_km: 0 }));
    this._active = this._items.length ? 0 : -1;
    this._draw();
  },

  async _createPlace(place, kind) {
    await App.api("/api/places", {
      method: "POST",
      body: { label: place.name, lat: place.lat, lon: place.lon, address: place.address },
    });
    this._placeMode = false;
    this._menu.querySelector(".sp-head span").textContent =
      kind === "market" ? "Farmer's market" : "Grocery store";
    this._input.placeholder = "Type a store name…";
    this._input.value = "";
    App.toast(`Home set to ${place.name}`);
    this._search(kind, true);
  },

  _draw() {
    const list = this._menu.querySelector(".sp-list");
    if (!this._items.length) {
      list.innerHTML = `<div class="sp-empty">Nothing nearby matches. Try the refresh, or a shorter name.</div>`;
      return;
    }
    list.innerHTML = "";
    this._items.forEach((shop, i) => {
      const sub = shop._place
        ? App.esc(shop.address || shop.country || "")
        : `${App.esc(shop.address || shop.kind)} · ${shop.distance_km} km`;
      const row = App.el(`
        <div class="sp-row ${i === this._active ? "active" : ""}">
          <div class="sp-row-main">
            <span class="sp-name">${App.esc(shop.name)}</span>
            ${shop.chain === "kroger" ? '<span class="sp-live" title="Live prices available for this chain">live</span>' : ""}
          </div>
          <div class="sp-row-sub dim">${sub}</div>
        </div>
      `);
      row.addEventListener("mouseenter", () => { this._active = i; this._paint(); });
      row.addEventListener("click", () => this._pick(shop));
      list.appendChild(row);
    });
  },

  _paint() {
    Array.from(this._menu.querySelectorAll(".sp-row"))
      .forEach((row, i) => row.classList.toggle("active", i === this._active));
  },

  _key(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this._items.length) return;
      this._active = (this._active + (e.key === "ArrowDown" ? 1 : -1) + this._items.length) % this._items.length;
      this._paint();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (this._active >= 0) this._pick(this._items[this._active]);
      return;
    }
    if (e.key === "Escape") { e.stopPropagation(); this.close(); }
  },

  _pick(shop) {
    if (shop._place) { this._createPlace(shop, this._kind); return; }
    const cb = this._onPick;
    this.close();
    if (cb) cb(shop);
  },
};
