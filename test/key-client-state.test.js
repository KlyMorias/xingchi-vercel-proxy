const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../assets/codex-config');
const source = fs.readFileSync(path.join(__dirname, '../assets/key.js'), 'utf8');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const token = suffix => `kly_${suffix.repeat(43)}`;
function account({ username = 'Owner', role = 'admin', key = null } = {}) {
  return { user: { username, role, enabled: true }, key, limits: { hourly_requests: 20, daily_requests: 50, weekly_requests: 200, requests_per_minute: 5 },
    usage: { used_today: 0, remaining_today: 50, used_this_hour: 0, remaining_this_hour: 20, used_this_week: 0, remaining_this_week: 200 },
    service: { model: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol' }], generation_available: true } };
}
function metadata(secret, created = '2026-11-21T00:00:00Z') {
  return { prefix: secret.slice(0, 12), created_at: created, expires_at: '2026-12-21T00:00:00Z' };
}
function fixture(initial = account(), { lazyModule = false } = {}) {
  let now = Date.parse('2026-11-21T12:00:00Z');
  let nextTimer = 1;
  let snapshot = initial;
  let postKey = token('A');
  let handler;
  const timers = new Map(), nodes = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const calls = [], copied = [], redirects = [], playground = { models: [], clears: 0, disposed: 0 };
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.events = new Map(); this.attributes = new Map(); this.dataset = {};
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false; this._classes = new Set();
      this.classList = { add: (...names) => names.forEach(n => this._classes.add(n)), remove: (...names) => names.forEach(n => this._classes.delete(n)),
        contains: name => this._classes.has(name), toggle: (name, force) => { const add = force === undefined ? !this._classes.has(name) : force; if (add) this._classes.add(name); else this._classes.delete(name); return add; } };
    }
    set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }
    get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...items) { for (const item of items) item.fragment ? this.children.push(...item.children) : this.children.push(item); }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    addEventListener(name, callback) { if (!this.events.has(name)) this.events.set(name, []); this.events.get(name).push(callback); }
    async emit(name, event = {}) { await Promise.all((this.events.get(name) || []).map(callback => callback({ preventDefault() {}, ...event, currentTarget: this }))); }
    focus() { document.activeElement = this; for (const cb of this.events.get('focus') || []) cb({ currentTarget: this }); }
    querySelector(selector) {
      if (selector === 'span') return this.span || (this.span = new Element('span'));
      return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(node => node instanceof Element ? [node, ...node.querySelectorAll('*')] : []);
      if (selector === '*') return descendants;
      if (selector.startsWith('.')) return descendants.filter(node => node.classList.contains(selector.slice(1)));
      if (selector === 'input[type="password"]') return [...nodes.values()].filter(node => node.type === 'password');
      return [];
    }
    showModal() { this.open = true; }
    close() { this.open = false; for (const callback of this.events.get('close') || []) callback({ currentTarget: this }); }
    reset() {}
    scrollIntoView() {}
    remove() {}
    click() { return this.emit('click'); }
  }
  const byId = id => {
    if (!nodes.has(id)) { const node = new Element(id.endsWith('dialog') ? 'dialog' : id.endsWith('form') ? 'form' : 'div'); node.id = id; nodes.set(id, node); }
    return nodes.get(id);
  };
  document = { hidden: false, activeElement: null, body: new Element('body'), head: new Element('head'), getElementById: byId, createElement: tag => new Element(tag),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }), createTextNode: text => ({ textContent: text }),
    addEventListener(name, callback) { if (!documentEvents.has(name)) documentEvents.set(name, []); documentEvents.get(name).push(callback); },
    querySelector(selector) { return selector === 'dialog[open]' ? [...nodes.values()].find(node => node.open) || null : null; },
    querySelectorAll(selector) { return selector === 'input[type="password"]' ? [...nodes.values()].filter(node => node.type === 'password') : []; } };
  document.body.classList.add('auth-pending');
  for (const id of ['current-password', 'new-password', 'confirm-password', 'user-password']) byId(id).type = 'password';
  byId('user-filter').value = 'all';
  const location = { hash: '', replace: target => redirects.push(target) };
  const window = { location, KlyCodexConfig: config, KlyPlayground: { init(options) { playground.options = options; return { setModels(models) { playground.models = models; }, clearKey() { playground.clears++; }, dispose() { playground.disposed++; } }; } },
    history: { pushState(_a, _b, hash) { location.hash = hash; }, replaceState(_a, _b, hash) { location.hash = hash; } },
    addEventListener(name, callback) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(callback); }, scrollTo() {}, confirm: () => true };
  const playgroundModule = window.KlyPlayground;
  if (lazyModule) { window.KlyPlayground = undefined; byId('playground-view').dataset.module = '/assets/playground.js'; }
  const schedule = (callback, delay, interval = false) => { const id = nextTimer++; timers.set(id, { callback, due: now + delay, delay, interval }); return id; };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => structuredClone(body) });
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method, signal: options.signal });
    const custom = handler && await handler(url, options);
    if (custom) return custom;
    if (url === '/api/account') return response(snapshot);
    if (url === '/api/keys' && options.method === 'POST') { snapshot = { ...snapshot, key: metadata(postKey) }; return response({ ...snapshot, api_key: postKey }, 201); }
    if (url === '/api/users') return response({ users: [snapshot.user] });
    throw new Error(`Unexpected fetch ${options.method} ${url}`);
  };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  vm.runInNewContext(source, { window, document, navigator: { clipboard: { writeText: async value => { copied.push(value); } } }, fetch,
    AbortController, Date: ClockDate, Intl, Blob, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    setTimeout: (cb, ms) => schedule(cb, ms), clearTimeout: id => timers.delete(id), setInterval: (cb, ms) => schedule(cb, ms, true), clearInterval: id => timers.delete(id),
    requestAnimationFrame: cb => cb(), console }, { filename: 'assets/key.js' });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  const event = async (events, name, detail) => { await Promise.all((events.get(name) || []).map(cb => cb({ preventDefault() {}, ...detail }))); await flush(); };
  return { byId, calls, copied, redirects, playground, response, flush, document, window,
    async loadModule() { window.KlyPlayground = playgroundModule; document.head.children.at(-1).onload(); await flush(); },
    setSnapshot(value) { snapshot = value; }, setPostKey(value) { postKey = value; }, setHandler(value) { handler = value; },
    click: async id => { await byId(id).emit('click'); await flush(); },
    windowEvent: (name, detail = {}) => event(windowEvents, name, detail),
    documentEvent: (name, detail = {}) => event(documentEvents, name, detail),
    async advance(ms) { now += ms; const ready = [...timers].filter(([, timer]) => timer.due <= now); for (const [id, timer] of ready) { if (!timers.has(id)) continue; if (timer.interval) timer.due = now + timer.delay; else timers.delete(id); timer.callback(); } await flush(); },
    timerCount: () => timers.size };
}

test('client retains a newly created key for matching refreshes and clears it on external rotation', async () => {
  const f = fixture(); await f.flush(); assert.equal(f.calls.filter(c => c.url === '/api/account').length, 1);
  await f.click('nav-playground');
  await f.click('create-key'); await f.click('reveal-key'); assert.equal(f.byId('key-value').textContent, token('A'));
  await f.click('refresh-usage'); assert.equal(f.byId('key-value').textContent, token('A'));
  f.setSnapshot(account({ key: metadata(token('B')) })); await f.click('refresh-usage');
  assert.equal(f.byId('reveal-key').hidden, true); assert.equal(f.byId('copy-key').hidden, true);
  assert.equal(f.byId('key-value').textContent.includes(token('A')), false);
  await f.click('copy-codex-config'); assert.ok(f.copied.at(-1).includes(config.PLACEHOLDER)); assert.equal(f.copied.at(-1).includes(token('A')), false);
  assert.ok(f.playground.clears > 0);
});

test('an identity/role switch updates the account and cannot restore the previous admin user list', async () => {
  const f = fixture(account({ key: metadata(token('A')) })); await f.flush();
  const pending = deferred(); f.setHandler(url => url === '/api/users' ? pending.promise : undefined);
  await f.click('nav-users');
  f.setSnapshot(account({ username: 'Member', role: 'user', key: metadata(token('B')) }));
  await f.click('refresh-usage');
  assert.equal(f.byId('sidebar-user').textContent, 'Member'); assert.equal(f.byId('nav-users').hidden, true);
  assert.equal(f.byId('overview-view').hidden, false); assert.equal(f.byId('user-list').children.length, 0);
  pending.resolve(f.response({ users: [{ username: 'PrivateAdmin', role: 'admin', enabled: true }] })); await f.flush();
  assert.equal(f.byId('user-list').children.length, 0); assert.equal(f.byId('users-count').textContent, '—');
});

test('BFcache restore revalidates the session and pending key creation cannot resurrect a cleared secret', async () => {
  const f = fixture(); await f.flush(); const pending = deferred();
  f.setHandler((url, options) => url === '/api/keys' && options.method === 'POST' ? pending.promise : undefined);
  const creating = f.click('create-key'); await f.flush();
  f.byId('current-password').value = 'private password';
  await f.windowEvent('pagehide', { persisted: true });
  assert.equal(f.byId('current-password').value, ''); assert.equal(f.playground.disposed, 0);
  pending.resolve(f.response({ ...account({ key: metadata(token('A')) }), api_key: token('A') }, 201)); await creating;
  assert.equal(f.byId('codex-config').textContent.includes(token('A')), false);
  f.setSnapshot(account({ username: 'RestoredMember', role: 'user', key: metadata(token('B')) }));
  await f.windowEvent('pageshow', { persisted: true });
  assert.equal(f.calls.filter(c => c.url === '/api/account').length, 2);
  assert.equal(f.byId('auth-cover').hidden, true); assert.equal(f.byId('sidebar-user').textContent, 'RestoredMember');
  assert.equal(f.byId('reveal-key').hidden, true);
  await f.advance(61000); assert.equal(f.calls.filter(c => c.url === '/api/account').length, 3);
});

test('playground navigation is a proper view and makes no generation request by itself', async () => {
  const f = fixture(); await f.flush(); assert.equal(f.playground.options, undefined); await f.click('nav-playground');
  assert.equal(f.window.location.hash, '#playground'); assert.equal(f.byId('playground-view').hidden, false);
  assert.equal(f.byId('overview-view').hidden, true); assert.equal(f.byId('nav-playground').getAttribute('aria-current'), 'page');
  assert.equal(f.calls.length, 1); assert.equal(f.playground.models[0].id, 'gpt-6.1-sol');
  await f.windowEvent('pagehide', { persisted: false }); assert.equal(f.playground.disposed, 1);
});

test('playground loads once on demand and a pending module cannot initialize after page exit', async () => {
  const f = fixture(account(), { lazyModule: true }); await f.flush();
  assert.equal(f.document.head.children.length, 0);
  await f.click('nav-playground'); await f.click('nav-overview'); await f.click('nav-playground');
  assert.equal(f.document.head.children.length, 1);
  assert.equal(f.byId('playground-send').disabled, true);
  await f.windowEvent('pagehide', { persisted: true });
  await f.loadModule(); assert.equal(f.playground.options, undefined);
  await f.windowEvent('pageshow', { persisted: true });
  assert.ok(f.playground.options);
  assert.equal(f.document.head.children.length, 1);
  assert.equal(f.playground.options.getKey(), null);
});
