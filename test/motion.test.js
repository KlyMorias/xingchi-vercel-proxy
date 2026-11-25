const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../assets/motion.js"), "utf8");

function eventTarget() {
  const listeners = new Map();
  return { listeners,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    emit(type, event = {}) { for (const callback of [...(listeners.get(type) || [])]) callback(event); } };
}
function node({ tag = "section", top = 100, height = 200, width = 1000, hidden = false, form = false, image = false } = {}) {
  const classes = new Set();
  const properties = new Map();
  const element = { ...eventTarget(), tagName: tag.toUpperCase(), isConnected: true, hidden,
    form, image, box: { top, left: 0, width, height }, parent: null, writes: 0,
    classList: { add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name) },
    style: { setProperty(name, value) { properties.set(name, value); element.writes++; },
      removeProperty(name) { properties.delete(name); }, getPropertyValue: (name) => properties.get(name) || "" },
    closest(selector) {
      for (let current = this; current; current = current.parent) {
        if (selector === "[hidden], [inert]" && current.hidden) return current;
        if (selector === "form, dialog" && ["FORM", "DIALOG"].includes(current.tagName)) return current;
        if (selector === "a, button" && ["A", "BUTTON"].includes(current.tagName)) return current;
      }
      return null;
    },
    querySelector(selector) { return selector === ".cinematic-image" && image ? {} : selector === "form" && form ? {} : null; },
    getBoundingClientRect() { return { ...this.box, bottom: this.box.top + this.box.height }; },
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; } };
  return element;
}
function fixture({ reduce = false, fine = true, intersection = true, media = true, candidates = [], photo = node({ image: true, height: 400 }), catalog = node() } = {}) {
  const frames = new Map();
  const observers = [];
  const mutations = [];
  let nextFrame = 1;
  const root = node();
  const reducedMedia = { ...eventTarget(), matches: reduce };
  const fineMedia = { ...eventTarget(), matches: fine };
  const document = { ...eventTarget(), documentElement: root, hidden: false, readyState: "complete",
    querySelectorAll(selector) { return selector.startsWith(".cinematic-hero") ? [photo] : candidates; },
    getElementById(id) { return id === "model-catalog" ? catalog : null; } };
  const window = { ...eventTarget(), innerHeight: 800,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; mutations.push(this); }
      observe(target, options) { this.target = target; this.options = options; }
      disconnect() { this.disconnected = true; }
    } };
  if (media) window.matchMedia = (query) => query.includes("reduced-motion") ? reducedMedia : fineMedia;
  if (intersection) window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.observed = new Set(); observers.push(this); }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
  };
  vm.runInNewContext(source, { window, document }, { filename: "assets/motion.js" });
  return { root, document, window, photo, frames, candidates, observers, mutations, catalog,
    flush() { const ready = [...frames]; frames.clear(); for (const [, callback] of ready) callback(); },
    reduce(value) { reducedMedia.matches = value; reducedMedia.emit("change"); },
    pointer(value) { fineMedia.matches = value; fineMedia.emit("change"); } };
}

test("reduced-motion preference and absent preference API leave all content static and visible", () => {
  for (const options of [{ reduce: true }, { media: false }]) {
    const below = node({ top: 1200 });
    const f = fixture({ ...options, candidates: [below] });
    assert.equal(f.root.classList.contains("has-motion"), false);
    assert.equal(below.classList.contains("reveal-pending"), false);
    assert.equal(f.observers.length, 0);
    assert.equal(f.photo.writes, 0);
    f.window.emit("scroll");
    assert.equal(f.frames.size, 0);
  }
});

test("only below-fold visible non-form panels wait for reveal", () => {
  const above = node({ top: 50 });
  const below = node({ top: 1100 });
  const hidden = node({ top: 1200, hidden: true });
  const input = node({ tag: "input", top: 1200 });
  const form = node({ tag: "form", top: 1200 });
  const formPanel = node({ form: true, top: 1200 });
  const insideForm = node({ top: 1200 }); insideForm.parent = form;
  const f = fixture({ candidates: [above, below, hidden, input, form, formPanel, insideForm] });
  assert.equal(f.root.classList.contains("has-motion"), true);
  assert.deepEqual([...f.observers[0].observed], [below]);
  for (const element of [above, hidden, input, form, formPanel, insideForm]) assert.equal(element.classList.contains("reveal-pending"), false);
  f.observers[0].callback([{ target: below, isIntersecting: true }]);
  assert.equal(below.classList.contains("reveal-pending"), false);
  assert.equal(below.classList.contains("is-visible"), true);
  assert.equal(f.observers[0].observed.has(below), false);
  assert.equal(f.frames.size, 0, "A completed reveal must not start an animation loop");
});

test("missing IntersectionObserver never hides below-fold content", () => {
  const below = node({ top: 1500 });
  const f = fixture({ intersection: false, candidates: [below] });
  assert.equal(below.classList.contains("reveal-pending"), false);
  f.window.emit("hashchange"); f.flush();
  assert.equal(below.classList.contains("reveal-pending"), false);
});

test("pointer bursts coalesce into one frame and photo offsets are bounded", () => {
  const f = fixture();
  const initialWrites = f.photo.writes;
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: -10000, clientY: -10000 });
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: 10000, clientY: 10000 });
  assert.equal(f.frames.size, 1);
  assert.equal(f.photo.writes, initialWrites, "Pointer events must not perform eager style writes");
  f.flush();
  assert.equal(f.photo.writes, initialWrites + 3);
  assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "8.00px");
  assert.equal(f.photo.style.getPropertyValue("--pointer-y"), "8.00px");
  assert.equal(f.frames.size, 0, "No idle requestAnimationFrame loop");
  f.photo.box.top = -290;
  f.window.emit("scroll"); f.flush();
  assert.equal(f.photo.style.getPropertyValue("--scroll-shift"), "35.00px");
  f.photo.emit("pointerleave"); f.flush();
  assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "0.00px");
  f.photo.box.top = -500;
  f.window.emit("scroll"); f.flush();
  assert.equal(f.photo.style.getPropertyValue("--scroll-shift"), "");
});

test("coarse pointers never receive pointer or scroll parallax", () => {
  const f = fixture({ fine: false });
  assert.equal(f.photo.listeners.get("pointermove")?.size || 0, 0);
  f.photo.emit("pointermove", { pointerType: "touch", clientX: 900, clientY: 500 });
  f.window.emit("scroll"); f.flush();
  assert.equal(f.photo.writes, 0);
  assert.equal(f.photo.style.getPropertyValue("--scroll-shift"), "");
});

test("changing to reduced motion cancels pending frames and clears every managed state", () => {
  const below = node({ top: 1400 });
  const f = fixture({ candidates: [below] });
  f.photo.emit("pointermove", { clientX: 700, clientY: 200 });
  assert.equal(f.frames.size, 1);
  f.reduce(true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.root.classList.contains("has-motion"), false);
  assert.equal(below.classList.contains("reveal-pending"), false);
  assert.equal(below.classList.contains("is-visible"), false);
  assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "");
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.mutations[0].disconnected, true);
  f.reduce(false);
  assert.equal(f.root.classList.contains("has-motion"), true);
  assert.equal(below.classList.contains("reveal-pending"), false, "Restoring motion must not rehide previously exposed content");
});

test("pagehide and hidden pages stop work, while BFCache restore reinstates input handling", () => {
  const f = fixture();
  f.window.emit("scroll"); assert.equal(f.frames.size, 1);
  f.window.emit("pagehide", { persisted: true });
  assert.equal(f.frames.size, 0);
  assert.equal(f.root.classList.contains("has-motion"), false);
  f.photo.emit("pointermove", { clientX: 200, clientY: 100 });
  assert.equal(f.frames.size, 0);
  f.window.emit("pageshow", { persisted: true });
  assert.equal(f.root.classList.contains("has-motion"), true);
  f.photo.emit("pointermove", { clientX: 200, clientY: 100 });
  assert.equal(f.frames.size, 1);
  f.document.hidden = true;
  f.document.emit("visibilitychange");
  assert.equal(f.frames.size, 0);
  assert.equal(f.root.classList.contains("has-motion"), false);
  f.document.hidden = false;
  f.document.emit("visibilitychange");
  assert.equal(f.root.classList.contains("has-motion"), true);
});

test("view changes and scoped catalog insertions discover new visible targets", () => {
  const initiallyHidden = node({ top: 1100, hidden: true });
  const f = fixture({ candidates: [initiallyHidden] });
  assert.equal(initiallyHidden.classList.contains("reveal-pending"), false);
  initiallyHidden.hidden = false;
  f.document.emit("click", { target: node({ tag: "button" }) }); f.flush();
  assert.equal(initiallyHidden.classList.contains("reveal-pending"), true);
  initiallyHidden.hidden = true;
  f.window.emit("hashchange"); f.flush();
  assert.equal(initiallyHidden.classList.contains("reveal-pending"), false);
  const added = node({ top: 1400 }); f.candidates.push(added);
  assert.equal(f.mutations[0].target, f.catalog);
  assert.equal(f.mutations[0].options.childList, true);
  assert.equal(f.mutations[0].options.subtree, undefined, "No broad document/metrics subtree observer");
  f.mutations[0].callback([]); f.flush();
  assert.equal(added.classList.contains("reveal-pending"), true);
});
