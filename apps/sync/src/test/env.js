// Minimal browser shims so the app's own modules can be exercised under Vitest's
// plain `node` environment (this repo has no jsdom). Only what the modules under
// test actually touch — anything more and the tests start passing against a
// fiction instead of the real code.
//
// Ported from SYNC's scripts/_env.mjs. Two things were added that the original
// standalone runner never needed: `location`, because module-scope code reads
// window.location.* and a bare object throws before a single test runs, and
// `screen`, because the layout hooks read it at import. Both are the smallest
// value that is still true.

export class MemoryStorage {
  #map = new Map();
  getItem(k) { return this.#map.has(k) ? this.#map.get(k) : null; }
  setItem(k, v) { this.#map.set(k, String(v)); }
  removeItem(k) { this.#map.delete(k); }
  clear() { this.#map.clear(); }
}

export function installBrowserEnv() {
  if (!globalThis.localStorage) globalThis.localStorage = new MemoryStorage();
  if (!globalThis.window) {
    globalThis.window = {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      // Present in the original only by accident of never being reached: any
      // module that reads window.location.hostname at import time throws
      // "Cannot read properties of undefined" before the suite starts.
      location: { hostname: "localhost", href: "http://localhost/", origin: "http://localhost" },
      screen: { height: 852, width: 393 },
    };
  }
  if (!globalThis.location) {
    globalThis.location = globalThis.window.location;
  }
  if (!globalThis.screen) {
    globalThis.screen = globalThis.window.screen;
  }
  if (!globalThis.document) {
    globalThis.document = {
      hidden: false,
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    };
  }
  // Node 21+ ships a real `navigator` (userAgent "Node.js/22"), which is enough
  // for the device-label sniffing in cloud.js. Older runtimes get a stand-in.
  if (!globalThis.navigator) {
    globalThis.navigator = { userAgent: "node", language: "en-US" };
  }
}
