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
function node({ tag = "section", className = "", top = 100, height = 200, width = 1000, hidden = false, form = false, image = false } = {}) {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
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
    contains(target) {
      for (let current = target; current; current = current.parent) if (current === this) return true;
      return false;
    },
    querySelector(selector) { return selector === ".cinematic-image" && image ? {} : selector === "form" && form ? {} : null; },
    matches(selector) { return selector.split(",").some((part) => classes.has(part.trim().slice(1))); },
    getBoundingClientRect() { return { ...this.box, bottom: this.box.top + this.box.height }; },
    getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; } };
  return element;
}
function fixture({ reduce = false, fine = true, intersection = true, media = true, authPending = false, candidates = [], photo = node({ image: true, height: 400 }), catalog = node() } = {}) {
  const frames = new Map();
  const observers = [];
  const mutations = [];
  let nextFrame = 1;
  const root = node();
  const body = node({ tag: "body", className: authPending ? "auth-pending" : "" });
  const reducedMedia = { ...eventTarget(), matches: reduce };
  const fineMedia = { ...eventTarget(), matches: fine };
  const document = { ...eventTarget(), documentElement: root, body, hidden: false, readyState: "complete",
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
  assert.equal(f.photo.writes, initialWrites + 2, "Only the two changed pointer axes need style writes");
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

test("stationary pointer and unchanged geometry do not rewrite photo transforms", () => {
  const f = fixture();
  const initialWrites = f.photo.writes;
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: 500, clientY: 300 });
  f.flush();
  assert.equal(f.photo.writes, initialWrites, "A centered pointer already matches the resting transform");
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: 700, clientY: 200 });
  f.flush();
  const movedWrites = f.photo.writes;
  assert.equal(movedWrites, initialWrites + 2);
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: 700, clientY: 200 });
  f.photo.emit("pointermove", { pointerType: "mouse", clientX: 700, clientY: 200 });
  f.window.emit("scroll");
  f.window.emit("resize");
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.photo.writes, movedWrites);
  assert.equal(f.frames.size, 0);
});

test("cancelled pointers and reopened hero views return to their resting tilt", () => {
  const f = fixture();
  const move = () => {
    f.photo.emit("pointermove", { pointerType: "pen", clientX: 1000, clientY: 500 });
    f.flush();
    assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "8.00px");
  };
  move();
  f.photo.emit("pointercancel"); f.flush();
  assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "0.00px");
  assert.equal(f.photo.style.getPropertyValue("--pointer-y"), "0.00px");
  for (const hidden of [true, false]) {
    move();
    if (hidden) f.photo.hidden = true;
    else f.photo.box.top = -600;
    f.window.emit("hashchange"); f.flush();
    assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "");
    f.photo.hidden = false; f.photo.box.top = 100;
    f.window.emit("hashchange"); f.flush();
    assert.equal(f.photo.style.getPropertyValue("--pointer-x"), "0.00px");
    assert.equal(f.photo.style.getPropertyValue("--pointer-y"), "0.00px");
  }
  f.window.emit("pagehide");
  f.photo.emit("pointercancel");
  assert.equal(f.frames.size, 0, "Stopped motion must remove pointer-cancel handling");
});

test("keyboard focus immediately exposes its pending panel without a reveal transition", () => {
  const below = node({ top: 1400 });
  const other = node({ top: 1700 });
  const button = node({ tag: "button", top: 1420 }); button.parent = below;
  const f = fixture({ candidates: [below, other] });
  assert.equal(below.classList.contains("reveal-pending"), true);
  f.document.emit("focusin", { target: button });
  assert.equal(below.classList.contains("reveal-pending"), false);
  assert.equal(below.classList.contains("is-visible"), false, "Base styles expose focused content without the animated class");
  assert.equal(f.observers[0].observed.has(below), false);
  assert.equal(other.classList.contains("reveal-pending"), true, "Other panels keep their independent entrance");
  assert.equal(f.frames.size, 0);
  f.window.emit("resize"); f.flush();
  assert.equal(below.classList.contains("reveal-pending"), false, "Focused content must not be remasked");
  f.window.emit("pagehide");
  assert.equal(f.document.listeners.get("focusin")?.size || 0, 0);
});

test("coarse pointers never receive pointer or scroll parallax", () => {
  const f = fixture({ fine: false });
  assert.equal(f.photo.listeners.get("pointermove")?.size || 0, 0);
  f.photo.emit("pointermove", { pointerType: "touch", clientX: 900, clientY: 500 });
  f.window.emit("scroll"); f.flush();
  assert.equal(f.photo.writes, 0);
  assert.equal(f.photo.style.getPropertyValue("--scroll-shift"), "");
});

test("photo motion pauses outside the viewport and in hidden views, including on touch screens", () => {
  for (const fine of [true, false]) {
    const f = fixture({ fine });
    assert.equal(f.photo.classList.contains("motion-in-view"), true);
    f.photo.box.top = -600;
    f.window.emit("scroll"); f.flush();
    assert.equal(f.photo.classList.contains("motion-in-view"), false);
    f.photo.box.top = 100;
    f.window.emit("scroll"); f.flush();
    assert.equal(f.photo.classList.contains("motion-in-view"), true);
    f.photo.hidden = true;
    f.window.emit("hashchange"); f.flush();
    assert.equal(f.photo.classList.contains("motion-in-view"), false);
    f.photo.hidden = false;
    f.window.emit("hashchange"); f.flush();
    assert.equal(f.photo.classList.contains("motion-in-view"), true);
    f.window.emit("pagehide");
    assert.equal(f.photo.classList.contains("motion-in-view"), false);
    assert.equal(f.frames.size, 0);
  }
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

test("completed entrance remains settled after visibility and BFCache restores while ambient motion resumes", () => {
  for (const className of ["hero-bottom", "auth-visual-copy"]) {
    const f = fixture();
    const target = node({ className });
    assert.equal(f.root.classList.contains("motion-entered"), false);
    f.document.emit("animationend", { animationName: "photo-drift", target });
    f.document.emit("animationend", { animationName: "soft-arrival", target: node({ className: "hero-meta" }) });
    assert.equal(f.root.classList.contains("motion-entered"), false, "Only the final entrance sentinel settles the introduction");
    f.document.emit("animationend", { animationName: "soft-arrival", target });
    assert.equal(f.root.classList.contains("motion-entered"), true);
    f.document.hidden = true;
    f.document.emit("visibilitychange");
    assert.equal(f.root.classList.contains("motion-entered"), true);
    assert.equal(f.root.classList.contains("has-motion"), false);
    f.document.hidden = false;
    f.document.emit("visibilitychange");
    f.window.emit("pagehide", { persisted: true });
    f.window.emit("pageshow", { persisted: true });
    assert.equal(f.root.classList.contains("motion-entered"), true);
    assert.equal(f.root.classList.contains("has-motion"), true);
    assert.equal(f.photo.classList.contains("motion-in-view"), true);
    assert.equal(f.frames.size, 0, "Restored ambient motion must not start a background frame loop");
  }
});

test("suspending an exposed entrance settles it rather than replaying its mask on return", () => {
  for (const type of ["visibilitychange", "pagehide"]) {
    const f = fixture();
    assert.equal(f.root.classList.contains("motion-entered"), false);
    if (type === "visibilitychange") { f.document.hidden = true; f.document.emit(type); }
    else f.window.emit(type, { persisted: true });
    assert.equal(f.root.classList.contains("motion-entered"), true);
    if (type === "visibilitychange") { f.document.hidden = false; f.document.emit(type); }
    else f.window.emit("pageshow", { persisted: true });
    assert.equal(f.root.classList.contains("motion-entered"), true);
    assert.equal(f.root.classList.contains("has-motion"), true);
    assert.equal(f.frames.size, 0);
  }
});

test("suspension behind the auth cover preserves the first real hero entrance", () => {
  const f = fixture({ authPending: true });
  const target = node({ className: "hero-bottom" });
  f.document.emit("animationend", { animationName: "soft-arrival", target });
  assert.equal(f.root.classList.contains("motion-entered"), false);
  f.document.hidden = true; f.document.emit("visibilitychange");
  f.document.hidden = false; f.document.emit("visibilitychange");
  f.window.emit("pagehide", { persisted: true });
  f.window.emit("pageshow", { persisted: true });
  assert.equal(f.root.classList.contains("motion-entered"), false, "A paused, unrevealed hero must still get its first entrance");
  f.document.body.classList.remove("auth-pending");
  f.document.emit("animationend", { animationName: "soft-arrival", target });
  assert.equal(f.root.classList.contains("motion-entered"), true);
});

test("initial reduced motion keeps the introduction settled when motion is enabled later", () => {
  const f = fixture({ reduce: true });
  assert.equal(f.root.classList.contains("has-motion"), false);
  assert.equal(f.root.classList.contains("motion-entered"), true);
  f.reduce(false);
  assert.equal(f.root.classList.contains("has-motion"), true);
  assert.equal(f.root.classList.contains("motion-entered"), true);
  assert.equal(f.frames.size, 0);
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
