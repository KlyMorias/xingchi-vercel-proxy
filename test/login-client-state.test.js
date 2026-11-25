const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../assets/login.js"), "utf8");

function target() {
  const listeners = new Map();
  const attributes = new Map();
  return {
    value: "", type: "text", hidden: true, disabled: false,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(callback); },
    async emit(type, event = {}) { await Promise.all((listeners.get(type) || []).map((callback) => callback({ preventDefault() {}, currentTarget: this, ...event }))); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function fixture() {
  const nodes = new Map(["login-form", "login-username", "login-password", "login-submit", "login-message", "toggle-password"].map((id) => [id, target()]));
  const byId = (id) => nodes.get(id);
  byId("login-password").type = "password";
  byId("toggle-password").setAttribute("aria-pressed", "false");
  byId("toggle-password").setAttribute("aria-label", "Şifreyi göster");
  const window = { ...target(), location: { replace() {} } };
  vm.runInNewContext(source, {
    document: { getElementById: byId }, window,
    fetch: async () => ({ ok: false }), AbortController, setTimeout, clearTimeout,
  }, { filename: "assets/login.js" });
  return { byId, window };
}

test("password visibility toggle exposes the same state visually and to assistive technology", async () => {
  const f = fixture();
  const password = f.byId("login-password");
  const toggle = f.byId("toggle-password");
  await toggle.emit("click");
  assert.equal(password.type, "text");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Şifreyi gizle");
  await toggle.emit("click");
  assert.equal(password.type, "password");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "Şifreyi göster");
});

test("leaving a revealed password clears it and resets its toggle before a BFCache return", async () => {
  for (const persisted of [true, false]) {
    const f = fixture();
    const password = f.byId("login-password");
    const toggle = f.byId("toggle-password");
    password.value = "temporary test value";
    await toggle.emit("click");
    await f.window.emit("pagehide", { persisted });
    await f.window.emit("pageshow", { persisted });
    assert.equal(password.value, "");
    assert.equal(password.type, "password");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.getAttribute("aria-label"), "Şifreyi göster");
    await toggle.emit("click");
    assert.equal(password.type, "text", "The restored control must still reveal on its next activation");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
  }
});
