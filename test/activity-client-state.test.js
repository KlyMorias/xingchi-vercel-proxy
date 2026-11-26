const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../assets/activity.js'), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function row(id = 'request_one', overrides = {}) {
  return { id, started_at: '2026-11-26T18:00:00.000Z', completed_at: '2026-11-26T18:00:00.250Z',
    model: 'gpt-6.1-sol', endpoint: 'v1/responses', key_id: 'key_web', key_name: 'Web sitesi', status: 'success',
    http_status: 200, error_code: null, latency_ms: 250, usage_status: 'verified', input_tokens: 17,
    output_tokens: 11, total_tokens: 28, response_id: 'resp_one', ...overrides };
}
function page(items = [row()], overrides = {}) {
  return { items, next_cursor: null, total: items.length,
    filters: { models: ['gpt-6.1-sol', 'gpt-6-astra'], keys: [{ id: 'key_web', name: 'Web sitesi' }, { id: 'key_codex', name: 'Codex' }] },
    model_health: [{ model: 'gpt-6.1-sol', last_success_at: '2026-11-26T18:00:00.250Z' }],
    retention: { notice: 'Son 30 gün · Hesaba özel kayıtlar' }, ...overrides };
}
function fixture() {
  let now = Date.parse('2026-11-26T18:00:00.000Z');
  let handler = async () => page();
  const nodes = new Map(), calls = [], health = [], downloads = [], blobs = [], timers = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.events = new Map(); this.attributes = new Map(); this.dataset = {};
      this.value = ''; this.hidden = false; this.disabled = false; this.className = ''; this._text = '';
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
    get firstElementChild() { return this.children[0] || null; }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get selectedIndex() { return this.options.findIndex(option => option.value === this.value); }
    append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
    replaceChildren(...items) { this._text = ''; this.children = []; this.append(...items); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, callback) {
      if (!this.events.has(name)) this.events.set(name, []);
      this.events.get(name).push(callback);
    }
    async emit(name) {
      // dispatchEvent-style dispatch deliberately permits disabled elements so
      // the tests can check that handlers use applied rather than draft state.
      const event = { preventDefault() {}, currentTarget: this, target: this };
      await Promise.all((this.events.get(name) || []).map(callback => callback(event)));
    }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return descendants;
      if (selector === 'input,select') return descendants.filter(child => ['INPUT', 'SELECT'].includes(child.tagName));
      if (selector === 'button[type="submit"]') return descendants.filter(child => child.tagName === 'BUTTON' && child.type === 'submit');
      return [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    reset() { for (const control of this.querySelectorAll('input,select')) control.value = ''; }
    click() {
      if (this.tagName === 'A') downloads.push({ href: this.href, download: this.download });
      else if (!this.disabled) return this.emit('click');
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }
  const byId = (id, tag = 'div') => {
    if (!nodes.has(id)) { const element = new Element(tag); element.id = id; nodes.set(id, element); }
    return nodes.get(id);
  };
  for (const id of ['activity-refresh', 'activity-more', 'activity-reset', 'activity-export', 'activity-try']) byId(id, 'button');
  const form = byId('activity-filters', 'form');
  for (const id of ['activity-from', 'activity-to']) form.append(byId(id, 'input'));
  for (const id of ['activity-model', 'activity-key', 'activity-status']) {
    const select = byId(id, 'select');
    const choices = id === 'activity-status' ? ['', 'success', 'error', 'cancelled', 'unknown', 'in_progress'] : [''];
    for (const value of choices) { const option = new Element('option'); option.value = value; select.append(option); }
    form.append(select);
  }
  const submit = new Element('button'); submit.type = 'submit'; form.append(submit);
  for (const id of ['activity-panel', 'activity-rows', 'activity-table-wrap', 'activity-empty', 'activity-filter-status',
    'activity-error', 'activity-count', 'activity-retention', 'activity-empty-text']) byId(id);
  const document = { getElementById: byId, createElement: tag => new Element(tag), body: new Element('body') };
  const window = {};
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  vm.runInNewContext(source, { document, window, Date: ClockDate, Intl, URLSearchParams, Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return 'blob:activity-' + blobs.length; }, revokeObjectURL() {} },
    setTimeout(callback) { timers.push(callback); return timers.length; } }, { filename: 'assets/activity.js' });
  const api = async (...args) => { calls.push(args); return handler(...args); };
  const instance = window.KlyActivity.init({ api, onTry() {}, onHealth(value) { health.push(value === null ? null : JSON.parse(JSON.stringify(value))); } });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { byId, instance, calls, health, downloads, blobs, document, submit, flush,
    setHandler(value) { handler = value; }, advance(ms) { now += ms; },
    async dispatch(id, event = 'click') { await byId(id).emit(event); await flush(); },
    async setFilter(id, value) { byId(id).value = value; await form.emit('change'); await flush(); } };
}
function params(call) { return new URL(call[0], 'https://klyapi.test').searchParams; }

test('draft filter changes disable pagination and CSV until explicitly applied', async () => {
  const f = fixture();
  f.setHandler(async () => page([row()], { next_cursor: 'cursor_first', total: 2 }));
  await f.instance.load();
  assert.equal(f.byId('activity-more').hidden, false);
  assert.equal(f.byId('activity-more').disabled, false);
  assert.equal(f.byId('activity-export').disabled, false);
  await f.setFilter('activity-status', 'error');
  assert.equal(f.calls.length, 1, 'changing a filter must not silently reload or issue an export');
  assert.equal(f.byId('activity-more').disabled, true);
  assert.equal(f.byId('activity-export').disabled, true);
  assert.equal(f.byId('activity-filter-status').hidden, false);
  assert.match(f.byId('activity-filter-status').textContent, /Filtrele/);
  await f.dispatch('activity-filters', 'submit');
  assert.equal(params(f.calls.at(-1)).get('status'), 'error');
  assert.equal(f.byId('activity-filter-status').hidden, true);
  assert.equal(f.byId('activity-more').disabled, false);
  assert.equal(f.byId('activity-export').disabled, false);
});

test('pagination keeps applied filters and cursor, deduplicates rows, and stops at the final page', async () => {
  const f = fixture();
  await f.instance.load(); f.calls.length = 0; // Populate the real model/project filter choices first.
  f.byId('activity-from').value = '2026-11-20'; f.byId('activity-to').value = '2026-11-26';
  f.byId('activity-model').value = 'gpt-6.1-sol'; f.byId('activity-key').value = 'key_web'; f.byId('activity-status').value = 'success';
  let request = 0;
  f.setHandler(async () => ++request === 1 ? page([row()], { next_cursor: 'opaque_cursor_123', total: 2 })
    : page([row(), row('request_two')], { total: 2 }));
  await f.instance.load({ force: true });
  await f.dispatch('activity-more');
  const query = params(f.calls[1]);
  for (const [key, value] of Object.entries({ from: '2026-11-20', to: '2026-11-26', model: 'gpt-6.1-sol', key_id: 'key_web', status: 'success', limit: '25', cursor: 'opaque_cursor_123' })) assert.equal(query.get(key), value);
  assert.equal(f.byId('activity-rows').children.length, 2);
  assert.match(f.byId('activity-count').textContent, /^2 \/ 2 kayıt/);
  assert.equal(f.byId('activity-more').hidden, true);
  assert.equal(f.byId('activity-model').value, 'gpt-6.1-sol');
  assert.equal(f.byId('activity-key').value, 'key_web');
});

test('clear removes account activity, cached model health and filter state and publishes onHealth([])', async () => {
  const f = fixture(); await f.instance.load();
  await f.setFilter('activity-status', 'error');
  f.instance.clear();
  assert.deepEqual(f.health.at(-1), []);
  assert.equal(f.byId('activity-rows').children.length, 0);
  assert.equal(f.byId('activity-table-wrap').hidden, true);
  assert.equal(f.byId('activity-empty').hidden, true);
  assert.equal(f.byId('activity-more').hidden, true);
  assert.equal(f.byId('activity-status').value, '');
  assert.equal(f.byId('activity-model').options.length, 1);
  assert.equal(f.byId('activity-key').options.length, 1);
  assert.equal(f.byId('activity-filter-status').hidden, true);
  assert.equal(f.byId('activity-panel').getAttribute('aria-busy'), 'false');
});

test('an old model-health response cannot overwrite the new account after identity revision changes', async () => {
  const f = fixture(), old = deferred(), fresh = [{ model: 'gpt-6-astra', last_success_at: '2026-11-26T19:00:00.000Z' }];
  let request = 0;
  f.setHandler(() => ++request === 1 ? old.promise : Promise.resolve(page([], { model_health: fresh })));
  const pending = f.instance.loadHealth();
  assert.equal(f.calls.length, 1);
  f.instance.clear();
  await f.instance.loadHealth();
  old.resolve(page([], { model_health: [{ model: 'old-account-private-model' }] }));
  await pending;
  assert.deepEqual(f.health, [[], fresh]);
  assert.equal(JSON.stringify(f.health).includes('old-account-private-model'), false);
  assert.equal(f.calls.length, 2);
  await f.instance.loadHealth();
  assert.equal(f.calls.length, 2, 'only the current account health may be reused from cache');
  assert.deepEqual(f.health.at(-1), fresh);
});

test('old activity responses and old health errors cannot repopulate a cleared identity', async () => {
  const f = fixture(), oldPage = deferred(), oldHealth = deferred();
  f.setHandler(url => url.endsWith('limit=1') ? oldHealth.promise : oldPage.promise);
  const healthRequest = f.instance.loadHealth(), activityRequest = f.instance.load({ force: true });
  f.instance.clear();
  oldPage.resolve(page([row('old-account-request')]));
  oldHealth.reject(new Error('old-account-diagnostic'));
  await Promise.all([healthRequest, activityRequest]);
  assert.deepEqual(f.health, [[]]);
  assert.equal(f.byId('activity-rows').children.length, 0);
  assert.equal(f.byId('activity-error').hidden, true);
  assert.equal(f.byId('activity-panel').getAttribute('aria-busy'), 'false');
});

test('CSV exports all matching applied filters, never the unsubmitted draft or pagination cursor', async () => {
  const f = fixture();
  await f.instance.load(); f.calls.length = 0;
  f.byId('activity-from').value = '2026-11-20'; f.byId('activity-to').value = '2026-11-26';
  f.byId('activity-model').value = 'gpt-6.1-sol'; f.byId('activity-key').value = 'key_web'; f.byId('activity-status').value = 'success';
  const csv = '\ufeffid,status\r\nrequest_one,success\r\n';
  f.setHandler(async url => params([url]).get('format') === 'csv' ? csv : page([row()], { next_cursor: 'next_cursor', total: 2 }));
  await f.instance.load({ force: true });
  await f.setFilter('activity-status', 'error');
  await f.setFilter('activity-from', '2026-11-25');
  assert.equal(f.byId('activity-export').disabled, true, 'native user clicks cannot export an unapplied draft');
  // Invoke the event handler directly to verify its defensive choice of the
  // last applied filter even if a synthetic event reaches a disabled control.
  await f.dispatch('activity-export');
  const call = f.calls.at(-1), query = params(call);
  for (const [key, value] of Object.entries({ from: '2026-11-20', to: '2026-11-26', model: 'gpt-6.1-sol', key_id: 'key_web', status: 'success', format: 'csv' })) assert.equal(query.get(key), value);
  assert.equal(query.has('cursor'), false); assert.equal(query.has('limit'), false);
  assert.equal(call[1], 'GET'); assert.equal(call[2], undefined); assert.equal(call[3].responseType, 'text');
  assert.deepEqual(Buffer.from(await f.blobs[0].arrayBuffer()), Buffer.from(csv), 'the download preserves the complete CSV including its UTF-8 BOM');
  assert.equal(f.downloads.length, 1); assert.match(f.downloads[0].download, /^klyapi-istekler-2026-11-26\.csv$/);
  assert.equal(f.byId('activity-export').disabled, true, 'the unsubmitted draft remains visibly dirty after export');
});

test('a CSV response arriving after identity clear cannot start a download', async () => {
  const f = fixture(), pending = deferred(); await f.instance.load();
  f.setHandler(() => pending.promise);
  const exporting = f.byId('activity-export').emit('click');
  f.instance.clear(); pending.resolve('private old-account CSV');
  await exporting; await f.flush();
  assert.equal(f.downloads.length, 0); assert.equal(f.blobs.length, 0);
  assert.deepEqual(f.health.at(-1), []);
});
