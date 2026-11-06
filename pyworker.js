/* Python for the phone Meal Planner lives HERE, off the page's thread: a request can take seconds of
 * Python, and on the page's own thread that froze touch (swipes that start late, typing that lags).
 * bridge.js talks to this worker with {id, op, ...} messages and gets {id, result | error} back. */
"use strict";
importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");

const DATA = "/data";
let py = null, call = null;

const ops = {
  async boot({ packages, zipUrl }) {
    const bundle = fetch(zipUrl, { cache: "no-cache" }).then((r) => r.arrayBuffer());
    py = await loadPyodide({ packages });
    py.unpackArchive(await bundle, "zip", { extractDir: "/src" });
    py.FS.mkdirTree("/src/app/web");
    py.FS.mkdirTree(DATA);
  },
  async start({ code }) {
    await py.runPythonAsync(code);
    call = py.globals.get("_call");
  },
  async call({ method, path, body }) {
    const r = await call(method, path, body);
    const out = r.toJs();
    if (r.destroy) r.destroy();
    return out;
  },
  writeFile({ name, bytes }) { py.FS.writeFile(name.startsWith("/") ? name : DATA + "/" + name, bytes); },
  readFile({ name }) { try { return py.FS.readFile(DATA + "/" + name); } catch { return null; } },
  list({ pattern }) { const re = new RegExp(pattern); return py.FS.readdir(DATA).filter((n) => re.test(n)); },
  // a USDA answer fetched by the page, handed to mealplanner.fdc (see bridge.js resolveInBackground)
  jsStore({ key, status, text }) { py.pyimport("mealplanner.fdc").JS_STORE.set(key, py.toPy([status, text])); },
};

// messages that arrive before boot finishes wait their turn
let chain = Promise.resolve();
self.onmessage = (e) => {
  const { id, op } = e.data;
  chain = chain.then(async () => {
    try {
      const result = await ops[op](e.data);
      const transfer = result instanceof Uint8Array ? [result.buffer] : [];
      self.postMessage({ id, result }, transfer);
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
  });
};
