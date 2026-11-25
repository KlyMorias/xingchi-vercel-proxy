const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const config = require('../assets/codex-config');
const source = fs.readFileSync(path.join(__dirname, '../assets/key.js'), 'utf8');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const token = suffix => `kly_${suffix.repeat(43)}`;
function accounting(overrides = {}) {
  return { source: 'provider_usage', status: 'complete', quota_scope: 'application_daily', provider_balance: null,
    provider_balance_status: 'not_exposed', reserved_kind: 'admission_estimate', unknown_requests_today: 0,
    legacy_usage_unknown: false, last_settlement: null, ...overrides };
}
function account({ username = 'Owner', role = 'admin', key = null, usage = {} } = {}) {
  return { user: { username, role, enabled: true, daily_tokens: 1000000000, requests_per_minute: 5 }, key, limits: { daily_tokens: 1000000000, requests_per_minute: 5 },
    usage: { input_tokens_today: 0, output_tokens_today: 0, total_tokens_today: 0, reserved_tokens_today: 0, remaining_tokens_today: 1000000000,
      used_this_hour: 0, used_today: 0, used_this_week: 0, accounting: accounting(), ...usage },
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
      this.style = {};
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
    reportValidity() { return true; }
    scrollIntoView() {}
    remove() {}
    click() { return this.emit('click'); }
  }
  const byId = id => {
    if (!nodes.has(id)) { const node = new Element(id.endsWith('dialog') ? 'dialog' : id.endsWith('form') ? 'form' : 'div'); node.id = id; nodes.set(id, node); }
    return nodes.get(id);
  };
  const languages = Object.fromEntries(['curl', 'javascript', 'python'].map(language => {
    const button = new Element('button'); button.dataset.exampleLanguage = language; return [language, button];
  }));
  document = { hidden: false, activeElement: null, body: new Element('body'), head: new Element('head'), getElementById: byId, createElement: tag => new Element(tag),
    createDocumentFragment: () => Object.assign(new Element(), { fragment: true }), createTextNode: text => ({ textContent: text }),
    addEventListener(name, callback) { if (!documentEvents.has(name)) documentEvents.set(name, []); documentEvents.get(name).push(callback); },
    querySelector(selector) { return selector === 'dialog[open]' ? [...nodes.values()].find(node => node.open) || null : null; },
    querySelectorAll(selector) { return selector === 'input[type="password"]' ? [...nodes.values()].filter(node => node.type === 'password')
      : selector === '[data-example-language]' ? Object.values(languages) : []; } };
  document.body.classList.add('auth-pending');
  for (const id of ['current-password', 'new-password', 'confirm-password', 'user-password']) byId(id).type = 'password';
  byId('user-filter').value = 'all';
  const location = { hash: '', replace: target => redirects.push(target) };
  const window = { location, KlyCodexConfig: config, KlyPlayground: { init(options) { playground.options = options; return { setModels(models) { playground.models = models; }, setSelectedModel(model) { playground.selectedModel = model; }, clearKey() { playground.clears++; }, dispose() { playground.disposed++; } }; } },
    history: { pushState(_a, _b, hash) { location.hash = hash; }, replaceState(_a, _b, hash) { location.hash = hash; } },
    addEventListener(name, callback) { if (!windowEvents.has(name)) windowEvents.set(name, []); windowEvents.get(name).push(callback); }, scrollTo() {}, confirm: () => true };
  const playgroundModule = window.KlyPlayground;
  if (lazyModule) { window.KlyPlayground = undefined; byId('playground-view').dataset.module = '/assets/playground.js'; }
  const schedule = (callback, delay, interval = false) => { const id = nextTimer++; timers.set(id, { callback, due: now + delay, delay, interval }); return id; };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => structuredClone(body) });
  const fetch = async (url, options) => {
    calls.push({ url, method: options.method, signal: options.signal, body: options.body });
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
  return { byId, calls, copied, redirects, playground, response, flush, document, window, languages,
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
  assert.ok(f.byId('overview-code').textContent.includes(token('A')));
  await f.click('refresh-usage'); assert.equal(f.byId('key-value').textContent, token('A'));
  f.setSnapshot(account({ key: metadata(token('B')) })); await f.click('refresh-usage');
  assert.equal(f.byId('reveal-key').hidden, true); assert.equal(f.byId('copy-key').hidden, true);
  assert.equal(f.byId('key-value').textContent.includes(token('A')), false);
  assert.equal(f.byId('overview-code').textContent.includes(token('A')), false);
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

test('dashboard renders actual token usage and reservations without interpreting legacy request counts as tokens', async () => {
  const snapshot = account({ usage: { input_tokens_today: 1250, output_tokens_today: 750, total_tokens_today: 2000,
    reserved_tokens_today: 3000, remaining_tokens_today: 999995000, used_today: 50,
    server_time: '2026-11-21T12:00:00Z', day_resets_at: '2026-11-22T00:00:00Z' } });
  const f = fixture(snapshot); await f.flush();
  assert.equal(f.byId('daily-token-credit').textContent, '1 milyar');
  assert.equal(f.byId('daily-limit').textContent, '1.000.000.000');
  assert.equal(f.byId('usage-count').textContent, '2.000');
  assert.equal(f.byId('remaining-token-count').textContent, '999.995.000');
  assert.equal(f.byId('input-token-count').textContent, '1.250');
  assert.equal(f.byId('output-token-count').textContent, '750');
  assert.equal(f.byId('usage-progress').max, 1000000000);
  assert.equal(f.byId('usage-progress').value, 2000);
  assert.match(f.byId('remaining-label').textContent, /^999\.995\.000 token uygulama kotası kaldı · 12 sa sonra yenilenir$/);
  assert.equal(f.byId('reserved-token-note').hidden, false);
  assert.match(f.byId('reserved-token-note').textContent, /^3\.000 token/);
  f.setSnapshot(account()); await f.click('refresh-usage');
  assert.equal(f.byId('reserved-token-note').hidden, true);
  assert.equal(f.byId('usage-count').textContent, '0');
  assert.match(f.byId('remaining-label').textContent, /^1\.000\.000\.000 token uygulama kotası kaldı/);
});

test('dashboard requires explicit valid accounting and never turns missing or invalid token usage into zero', async () => {
  const f = fixture(); await f.flush();
  const unavailable = () => {
    for (const id of ['usage-count', 'input-token-count', 'output-token-count', 'remaining-token-count']) assert.equal(f.byId(id).textContent, '—', id);
    assert.equal(f.byId('usage-status').dataset.state, 'unavailable');
    assert.equal(f.byId('usage-progress').hidden, true);
    assert.equal(f.byId('usage-composition').hidden, true);
    assert.equal(f.byId('usage-receipt').hidden, true);
    assert.match(f.byId('usage-coverage').textContent, /sıfır kabul edilmedi/);
  };
  f.setSnapshot({ ...account(), usage: undefined }); await f.click('refresh-usage'); unavailable();
  for (const value of [undefined, null, {}, accounting({ source: 'estimated' }), accounting({ status: 'complete', unknown_requests_today: 1 }),
    accounting({ unknown_requests_today: '0' }), accounting({ provider_balance: 1000000000 }), accounting({ last_settlement: {} })]) {
    f.setSnapshot(account({ usage: { accounting: value } })); await f.click('refresh-usage'); unavailable();
  }
  for (const field of ['input_tokens_today', 'output_tokens_today', 'total_tokens_today', 'reserved_tokens_today']) {
    for (const value of [undefined, null, '', false, true, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, [], {}]) {
      f.setSnapshot(account({ usage: { [field]: value } })); await f.click('refresh-usage'); unavailable();
    }
  }
  f.setSnapshot(account({ usage: { input_tokens_today: 4, output_tokens_today: 3, total_tokens_today: 8 } }));
  await f.click('refresh-usage'); unavailable();
  f.setSnapshot(account()); await f.click('refresh-usage');
  assert.equal(f.byId('usage-count').textContent, '0');
  assert.equal(f.byId('usage-status').dataset.state, 'complete');
  assert.equal(f.byId('remaining-token-count').textContent, '1.000.000.000');
  assert.equal(f.byId('usage-composition').hidden, true);
});

test('daily application quota is never fabricated from missing limits or remaining fields', async () => {
  const f = fixture(); await f.flush();
  for (const value of [undefined, null, '', false, '1000000000', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    f.setSnapshot(account({ usage: { remaining_tokens_today: value } })); await f.click('refresh-usage');
    assert.equal(f.byId('usage-count').textContent, '0', 'known recorded usage remains visible');
    assert.equal(f.byId('remaining-token-count').textContent, '—');
    assert.equal(f.byId('usage-progress').hidden, true);
  }
  f.setSnapshot(account({ usage: { remaining_tokens_today: 999 } })); await f.click('refresh-usage');
  assert.equal(f.byId('remaining-token-count').textContent, '—', 'inconsistent server remaining is not displayed');
  const snapshot = account(); delete snapshot.limits; f.setSnapshot(snapshot); await f.click('refresh-usage');
  assert.equal(f.byId('daily-limit').textContent, '—');
  assert.equal(f.byId('daily-token-credit').textContent, '—');
  assert.equal(f.byId('minute-limit').textContent, '—');
  assert.equal(f.byId('remaining-token-count').textContent, '—');
  assert.match(f.byId('usage-coverage').textContent, /Günlük sınır uygulama kotasıdır/);
  assert.match(f.byId('usage-coverage').textContent, /satın alınmış bakiyesi bildirilmez/);
});

test('partial accounting shows recorded lower bounds, estimated holds and no available balance', async () => {
  const f = fixture(account({ usage: { input_tokens_today: 1250, output_tokens_today: 750, total_tokens_today: 2000,
    reserved_tokens_today: 100, remaining_tokens_today: 999997900,
    accounting: accounting({ status: 'partial', unknown_requests_today: 2, legacy_usage_unknown: true }) } }));
  await f.flush();
  assert.equal(f.byId('usage-count').textContent, 'En az 2.000');
  assert.equal(f.byId('input-token-count').textContent, 'En az 1.250');
  assert.equal(f.byId('output-token-count').textContent, 'En az 750');
  assert.equal(f.byId('usage-status').dataset.state, 'partial');
  assert.equal(f.byId('remaining-token-count').textContent, '—');
  assert.equal(f.byId('usage-progress').hidden, true);
  assert.match(f.byId('usage-coverage').textContent, /2 isteğin token kullanımı doğrulanamadı/);
  assert.match(f.byId('usage-coverage').textContent, /Önceki isteklerin token ayrıntıları bilinmiyor/);
  assert.match(f.byId('reserved-token-note').textContent, /100 token tahmini geçici rezervasyon/);
  assert.match(f.byId('reserved-token-note').textContent, /Gerçek kullanım değildir/);
  assert.equal(f.byId('usage-input-share').style.width, '62.5%');
  assert.equal(f.byId('usage-output-share').style.width, '37.5%');
  assert.match(f.byId('usage-composition').getAttribute('aria-label'), /1\.250 giriş \+ 750 çıkış = 2\.000 token/);
});

test('dashboard receipts and request counts show server records and clear invalid prior receipts', async () => {
  const receipt = { recorded_at: '2026-11-21T11:59:45.000Z', response_id: 'resp_measured', model: 'gpt-6.1-sol',
    input_tokens: 100, output_tokens: 20, total_tokens: 120 };
  const f = fixture(account({ usage: { input_tokens_today: 100, output_tokens_today: 20, total_tokens_today: 120,
    remaining_tokens_today: 999999880, used_this_hour: 2, used_today: 7, used_this_week: 19,
    accounting: accounting({ last_settlement: receipt }) } })); await f.flush();
  assert.equal(f.byId('usage-receipt').hidden, false);
  assert.equal(f.byId('receipt-time').getAttribute('datetime'), receipt.recorded_at);
  assert.match(f.byId('receipt-time').textContent, /UTC$/);
  assert.equal(f.byId('receipt-response').textContent, 'resp_measured');
  assert.equal(f.byId('receipt-model').textContent, 'gpt-6.1-sol');
  for (const [id, value] of [['receipt-input', '100'], ['receipt-output', '20'], ['receipt-total', '120'],
    ['usage-requests-hour', '2'], ['usage-requests-day', '7'], ['usage-requests-week', '19']]) assert.equal(f.byId(id).textContent, value);
  f.setSnapshot(account({ usage: { used_this_hour: null, used_today: '7', used_this_week: false,
    accounting: accounting({ last_settlement: { ...receipt, total_tokens: 999 } }) } })); await f.click('refresh-usage');
  assert.equal(f.byId('usage-receipt').hidden, true);
  assert.equal(f.byId('receipt-response').textContent, '—');
  assert.equal(f.byId('receipt-time').getAttribute('datetime'), null);
  for (const id of ['usage-requests-hour', 'usage-requests-day', 'usage-requests-week']) assert.equal(f.byId(id).textContent, '—');
});

test('failed refresh retains a visibly stale measured snapshot without changing counters', async () => {
  const f = fixture(account({ usage: { input_tokens_today: 8, output_tokens_today: 5, total_tokens_today: 13,
    remaining_tokens_today: 999999987 } })); await f.flush();
  f.setHandler(url => url === '/api/account' ? f.response({ error: { code: 'storage_unavailable' } }, 503) : undefined);
  await f.click('refresh-usage');
  assert.equal(f.byId('usage-count').textContent, '13');
  assert.equal(f.byId('remaining-token-count').textContent, '999.999.987');
  assert.equal(f.byId('usage-updated').classList.contains('stale'), true);
  assert.match(f.byId('usage-updated').textContent, /Son alınan veriler gösteriliyor/);
});

test('request example tabs generate real snippets and copy only the displayed key visibility', async () => {
  const f = fixture(); await f.flush(); await f.click('create-key');
  assert.equal(f.byId('overview-code').textContent.includes(token('A')), false);
  await f.languages.javascript.emit('click');
  assert.match(f.byId('overview-code').textContent, /await fetch\("https:\/\/klyapi\.vercel\.app\/api\/v1\/responses"/);
  assert.doesNotThrow(() => new vm.Script(`(async () => { ${f.byId('overview-code').textContent} })`), 'the displayed JavaScript parses without executing a request');
  assert.equal(f.byId('example-language-tag').textContent, 'JavaScript');
  assert.equal(f.languages.javascript.getAttribute('aria-pressed'), 'true');
  assert.equal(f.languages.curl.getAttribute('aria-pressed'), 'false');
  await f.click('copy-overview-code');
  assert.equal(f.copied.at(-1), f.byId('overview-code').textContent);
  assert.match(f.copied.at(-1), /Bearer YOUR_KEY/);
  assert.equal(f.copied.at(-1).includes(token('A')), false);
  await f.click('reveal-key'); await f.click('copy-overview-code');
  assert.ok(f.copied.at(-1).includes(token('A')));
  await f.languages.python.emit('click');
  assert.match(f.byId('overview-code').textContent, /import urllib\.request/);
  assert.equal(f.byId('example-language-tag').textContent, 'Python');
  assert.ok(f.byId('overview-code').textContent.includes(token('A')));
  await f.click('reveal-key'); await f.click('copy-overview-code');
  assert.equal(f.copied.at(-1).includes(token('A')), false);
  await f.click('copy-example');
  assert.match(f.copied.at(-1), /^curl /);
  assert.match(f.copied.at(-1), /Bearer YOUR_KEY/);
  assert.equal(f.calls.some(call => call.url === '/api/v1/responses'), false, 'changing language never sends a generation');
});

test('catalog try action opens the selected model in the playground without generating', async () => {
  const snapshot = account(); snapshot.service.models.push({ id: 'gpt-6-astra' });
  const f = fixture(snapshot); await f.flush(); await f.click('nav-models');
  const astraCard = f.byId('model-catalog').children[1];
  const tryModel = astraCard.children.at(-1).children.find(node => node.textContent === 'Modeli dene');
  assert.ok(tryModel);
  await tryModel.click(); await f.flush();
  assert.equal(f.byId('playground-view').hidden, false);
  assert.equal(f.byId('setup-model').value, 'gpt-6-astra');
  assert.equal(f.playground.selectedModel, 'gpt-6-astra');
  assert.equal(f.calls.some(call => call.url === '/api/v1/responses'), false);
});

test('admin creates an account with a rate limit and the common daily token allowance', async () => {
  const f = fixture(); await f.flush(); await f.click('add-user');
  assert.equal(f.byId('user-dialog').open, true);
  assert.match(f.byId('user-dialog-description').textContent, /1 milyar token/);
  f.byId('user-username').value = 'Guest_2'; f.byId('user-password').value = 'temporary-test-password';
  f.byId('user-minute').value = '10'; await f.byId('user-form').emit('submit'); await f.flush();
  const saved = f.calls.find(call => call.url === '/api/users' && call.method === 'POST');
  assert.deepEqual(JSON.parse(saved.body), { username: 'Guest_2', password: 'temporary-test-password', requests_per_minute: 10 });
  assert.equal(f.byId('user-dialog').open, false);
});
