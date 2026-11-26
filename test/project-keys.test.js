const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyStore, hashToken } = require('../lib/key-store');
const { createStateStore } = require('../lib/state-store');
const { createHandler } = require('../api/keys');
const { queryHistory } = require('../lib/request-history');

const originalEnv = { ...process.env };
test.beforeEach(() => { process.env.BLOB_STORE_ID = 'store_test'; });
test.afterEach(() => { process.env = { ...originalEnv }; });

function fixture(context) {
  let now = Math.floor(Date.parse('2026-11-26T12:00:00Z') / 1000);
  context.mock.method(Date, 'now', () => now * 1000);
  let state = { version: 1, users: {
    alice: { id: 'alice-id', username: 'alice', enabled: true, role: 'user', requests_per_minute: 100 },
    bob: { id: 'bob-id', username: 'bob', enabled: true, role: 'user', requests_per_minute: 100 },
  }, keys: {}, usage: {}, reservations: {}, login_attempts: {},
  sessions: { preserve: { user_id: 'alice-id', version: 1, expires_at: now + 86400 } } };
  let version = 0, writes = 0;
  const client = {
    async get() {
      const snapshot = JSON.stringify(state), etag = 'v' + version;
      await Promise.resolve();
      return { statusCode: 200, blob: { etag, size: Buffer.byteLength(snapshot) }, stream: new Response(snapshot).body };
    },
    async put(_path, value, options) {
      await Promise.resolve();
      if (options.ifMatch !== 'v' + version) throw new Error('Precondition failed');
      state = JSON.parse(value); version++; writes++;
      return { etag: 'v' + version };
    },
  };
  const instance = () => createKeyStore(createStateStore(client, { attempts: 30, pause: async () => {}, warn: () => {} }), { now: () => now });
  return { store: instance(), instance, state: () => state, writes: () => writes, now: () => now,
    change(callback) { callback(state); version++; }, setNow(value) { now = value; } };
}
function response() {
  return { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { this.body = body || ''; } };
}
function request(method = 'GET', body = {}, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { method, headers: { host: 'klyapi.vercel.app', origin: 'https://klyapi.vercel.app', 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text); } };
}
function api(f, userId = 'alice-id') { return createHandler(f.store, { async requireUser() { return { id: userId }; } }); }
const byId = (info, id) => info.keys.find(key => key.id === id);
const details = { request: { model: 'gpt-6.1-sol', endpoint: 'v1/responses' } };

test('named project keys have stable opaque public metadata and one-time plaintext only', async t => {
  const f = fixture(t);
  const sessions = structuredClone(f.state().sessions);
  const created = await Promise.all(['Web sitesi', 'Codex', 'Test'].map(name => f.store.createKey('alice-id', name)));
  const info = await f.store.getAccountInfo('alice-id');
  assert.equal(info.keys.length, 3);
  assert.equal(info.key_limits.max_active_keys, 10);
  assert.equal(new Set(info.keys.map(key => key.id)).size, 3);
  for (const [index, value] of created.entries()) {
    assert.equal(value.key.name, ['Web sitesi', 'Codex', 'Test'][index]);
    assert.match(value.key.id, /^key_[a-f0-9]{32}$/);
    assert.equal(value.key.prefix, value.api_key.slice(0, 12));
    const row = byId(info, value.key.id);
    assert.equal(row.total_tokens_today, 0);
    assert.equal(row.last_used_at, null);
    assert.equal(row.accounting.status, 'complete');
    assert.equal(row.accounting.scope, 'key_since_tracking');
    assert.equal(Date.parse(row.accounting.tracking_started_at), f.now() * 1000);
    assert.equal(JSON.stringify(f.state()).includes(value.api_key), false);
    assert.equal(JSON.stringify(info).includes(value.api_key), false);
    assert.equal(JSON.stringify(info).includes(hashToken(value.api_key)), false);
    assert.equal(row.remaining_tokens_today, undefined, 'There is no separate balance that could multiply account quota');
  }
  const before = structuredClone(f.state()), writes = f.writes();
  assert.deepEqual(await f.instance().getAccountInfo('alice-id'), info);
  assert.equal(f.writes(), writes, 'Listing project metadata is read-only');
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.state().sessions, sessions);
});

test('legacy credentials preserve their token and stable id while untracked past stays explicit', async t => {
  const f = fixture(t);
  const token = 'kly_' + 'A'.repeat(43), digest = hashToken(token);
  f.change(state => {
    state.keys[digest] = { user_id: 'alice-id', prefix: token.slice(0, 12), created_at: f.now() - 3600, expires_at: f.now() + 86400 };
    state.usage['alice-id'] = { day: Math.floor(f.now() / 86400), used_today: 1, input_tokens_today: 17, output_tokens_today: 8 };
  });
  const before = structuredClone(f.state());
  const initial = await f.store.getAccountInfo('alice-id');
  const key = initial.keys[0];
  assert.equal(key.name, 'Kişisel anahtar');
  assert.equal(key.accounting.legacy_usage_unknown, true);
  assert.equal(key.accounting.status, 'partial');
  assert.equal(key.accounting.tracking_started_at, null);
  assert.equal(key.total_tokens_today, 0, 'Historical account tokens are never guessed into a legacy project');
  assert.equal(initial.key.total_tokens_today, 25, 'Legacy single-key metadata keeps its account-level compatibility counters');
  assert.deepEqual(f.state(), before);
  assert.deepEqual(await f.store.authenticate(token), { ok: true });
  const access = await f.store.reserve(token, { estimatedTokens: 100, ...details });
  await f.store.settle(access.reservation, { input_tokens: 30, output_tokens: 12 });
  const current = await f.store.getAccountInfo('alice-id');
  assert.equal(current.keys[0].id, key.id);
  assert.equal(current.keys[0].total_tokens_today, 42);
  assert.equal(current.keys[0].accounting.legacy_usage_unknown, true);
  assert.equal(current.keys[0].accounting.status, 'partial');
  assert.equal(Date.parse(current.keys[0].accounting.tracking_started_at), f.now() * 1000);
  assert.equal(current.usage.total_tokens_today, 67);
  assert.deepEqual(await f.instance().authenticate(token), { ok: true });
});

test('legacy first-day uncertainty does not taint later fully tracked UTC days', async t => {
  const f = fixture(t);
  f.setNow(Math.floor(f.now() / 86400) * 86400 + 86370);
  const token = 'kly_' + 'L'.repeat(43), digest = hashToken(token);
  f.change(state => {
    state.keys[digest] = { user_id: 'alice-id', prefix: token.slice(0, 12),
      created_at: f.now() - 3600, expires_at: f.now() + 30 * 86400 };
  });
  const first = await f.store.reserve(token, { estimatedTokens: 100, ...details });
  await f.store.settle(first.reservation, { input_tokens: 7, output_tokens: 3 });
  const initial = (await f.store.getAccountInfo('alice-id')).keys[0];
  assert.equal(initial.total_tokens_today, 10);
  assert.equal(initial.accounting.status, 'partial');
  assert.equal(initial.accounting.legacy_usage_unknown, true);
  assert.equal(initial.accounting.historical_usage_unknown, true);

  f.setNow(f.now() + 31);
  const before = structuredClone(f.state()), writes = f.writes();
  const nextDay = (await f.store.getAccountInfo('alice-id')).keys[0];
  assert.equal(nextDay.total_tokens_today, 0);
  assert.equal(nextDay.accounting.status, 'complete');
  assert.equal(nextDay.accounting.legacy_usage_unknown, false);
  assert.equal(nextDay.accounting.historical_usage_unknown, true);
  assert.equal(nextDay.accounting.tracking_started_at, initial.accounting.tracking_started_at);
  assert.deepEqual(f.state(), before, 'Daily metadata does not rewrite the original historical gap');
  assert.equal(f.writes(), writes);

  const pending = await f.store.reserve(token, { estimatedTokens: 100, ...details });
  await f.store.markUnknown(pending.reservation);
  const uncertain = (await f.store.getAccountInfo('alice-id')).keys[0];
  assert.equal(uncertain.accounting.status, 'partial', 'New current-day uncertainty remains visible');
  assert.equal(uncertain.accounting.legacy_usage_unknown, false);
  assert.equal(uncertain.unknown_requests_today, 1);
  await f.store.settle(pending.reservation, { input_tokens: 11, output_tokens: 5 });
  const settled = (await f.store.getAccountInfo('alice-id')).keys[0];
  assert.equal(settled.total_tokens_today, 16);
  assert.equal(settled.accounting.status, 'complete');
  assert.equal(settled.accounting.historical_usage_unknown, true);
  assert.equal(f.state().keys[digest].usage.legacy_usage_unknown, true);
});

test('ten-active-key cap is atomic across instances and revoking one frees only one slot', async t => {
  const f = fixture(t), other = f.instance();
  const results = await Promise.allSettled(Array.from({ length: 13 }, (_, index) =>
    (index % 2 ? other : f.store).createKey('alice-id', 'Proje ' + index)));
  const created = results.filter(row => row.status === 'fulfilled').map(row => row.value);
  assert.equal(created.length, 10);
  assert(results.filter(row => row.status === 'rejected').every(row => row.reason.code === 'active_key_limit'));
  await f.store.revokeKey('alice-id', created[0].key.id);
  const replacement = await f.store.createKey('alice-id', 'Yeni proje');
  assert.equal(replacement.keys.length, 10);
  assert.equal((await f.store.authenticate(created[0].api_key)).ok, false);
  for (const previous of created.slice(1)) assert.equal((await f.store.authenticate(previous.api_key)).ok, true);
});

test('minute rate and daily token limits remain shared across all project keys', async t => {
  const f = fixture(t), other = f.instance();
  const a = await f.store.createKey('alice-id', 'Web'), b = await f.store.createKey('alice-id', 'Codex');
  f.change(state => { state.users.alice.requests_per_minute = 2; });
  assert.equal((await f.store.reserve(a.api_key, details)).ok, true);
  assert.equal((await other.reserve(b.api_key, details)).ok, true);
  const denied = await f.store.reserve(a.api_key, details);
  assert.equal(denied.code, 'rate_limited');
  const first = await f.store.getAccountInfo('alice-id');
  assert.equal(first.usage.used_today, 2);
  assert.equal(byId(first, a.key.id).used_today, 1);
  assert.equal(byId(first, b.key.id).used_today, 1);
  f.setNow(f.now() + 61);
  f.change(state => { state.usage['alice-id'].input_tokens_today = 999_999_997; });
  const race = await Promise.all([f.store.reserve(a.api_key, details), other.reserve(b.api_key, details)]);
  assert.equal(race.filter(row => row.ok).length, 1);
  assert.equal(race.find(row => !row.ok).code, 'daily_token_limit_exceeded');
  assert.equal((await f.store.getAccountInfo('alice-id')).usage.reserved_tokens_today, 3);
  const history = queryHistory(f.state(), 'alice-id', {}, f.now() * 1000);
  assert.equal(history.items.filter(row => row.http_status === 429).length, 2);
  assert(history.items.filter(row => row.http_status === 429).every(row => row.usage_status === 'not_started' && row.total_tokens === null));
});

test('per-project recorded usage settles once, keeps estimates separate and reconciles unknowns', async t => {
  const f = fixture(t), other = f.instance();
  const a = await f.store.createKey('alice-id', 'Web'), b = await f.store.createKey('alice-id', 'Codex');
  const first = await f.store.reserve(a.api_key, { estimatedTokens: 500, ...details });
  const second = await f.store.reserve(b.api_key, { estimatedTokens: 500, ...details });
  assert.equal((await f.store.getAccountInfo('alice-id')).keys.reduce((sum, key) => sum + key.total_tokens_today, 0), 0);
  await Promise.all([f.store.settle(first.reservation, { input_tokens: 17, output_tokens: 11 }), other.settle(first.reservation, { input_tokens: 17, output_tokens: 11 })]);
  await f.store.settle(second.reservation, { input_tokens: 3, output_tokens: 4 });
  const pending = await f.store.reserve(b.api_key, { estimatedTokens: 500, ...details });
  await Promise.all([f.store.markUnknown(pending.reservation), other.markUnknown(pending.reservation)]);
  let info = await f.store.getAccountInfo('alice-id');
  assert.equal(byId(info, a.key.id).total_tokens_today, 28);
  assert.equal(byId(info, a.key.id).unknown_requests_today, 0);
  assert.equal(byId(info, b.key.id).total_tokens_today, 7);
  assert.equal(byId(info, b.key.id).unknown_requests_today, 1);
  assert.equal(byId(info, b.key.id).accounting.status, 'partial');
  await f.store.settle(pending.reservation, { input_tokens: 5, output_tokens: 6 }, { response_id: 'resp_real_usage' });
  info = await f.store.getAccountInfo('alice-id');
  assert.equal(byId(info, b.key.id).total_tokens_today, 18);
  assert.equal(byId(info, b.key.id).unknown_requests_today, 0);
  assert.equal(byId(info, b.key.id).accounting.status, 'complete');
  assert.equal(info.usage.total_tokens_today, 46);
  assert.equal(info.usage.reserved_tokens_today, 0);
  assert.equal(byId(info, b.key.id).last_used_at, new Date(f.now() * 1000).toISOString());
  assert.equal(queryHistory(f.state(), 'alice-id', {}, f.now() * 1000).items.find(row => row.id === pending.reservation.id).response_id, 'resp_real_usage');
});

test('revoking a project never revokes another key and admitted usage still settles', async t => {
  const f = fixture(t);
  const a = await f.store.createKey('alice-id', 'Web'), b = await f.store.createKey('alice-id', 'Codex');
  const inFlight = await f.store.reserve(a.api_key, details);
  await f.store.revokeKey('alice-id', a.key.id);
  assert.equal((await f.store.authenticate(a.api_key)).ok, false);
  assert.equal((await f.store.reserve(a.api_key)).status, 401);
  assert.equal((await f.store.authenticate(b.api_key)).ok, true);
  await f.store.settle(inFlight.reservation, { input_tokens: 20, output_tokens: 10 });
  const info = await f.store.getAccountInfo('alice-id');
  assert.deepEqual(info.keys.map(row => row.id), [b.key.id]);
  assert.equal(info.usage.total_tokens_today, 30);
  assert.equal(f.state().keys[hashToken(a.api_key)].usage.input_tokens_today, 20);
  assert.equal(byId(info, b.key.id).total_tokens_today, 0);
  await assert.rejects(f.store.revokeKey('alice-id', a.key.id), error => error.status === 404);
  await f.store.renameKey('alice-id', b.key.id, 'Codex v2');
  assert.equal(f.state().keys[hashToken(a.api_key)], undefined, 'resolved revoked credential is cleaned, activity remains independent');
  assert.equal((await f.store.authenticate(b.api_key)).ok, true);
});

test('release refunds only its own project request count while preserving the shared abuse throttle', async t => {
  const f = fixture(t);
  const a = await f.store.createKey('alice-id', 'Web'), b = await f.store.createKey('alice-id', 'Codex');
  const first = await f.store.reserve(a.api_key, details), second = await f.store.reserve(b.api_key, details);
  await f.store.markUnknown(first.reservation);
  await f.store.release(first.reservation, { activity: { status: 'error', http_status: 403, error_code: 'upstream_denied' } });
  await f.store.release(first.reservation);
  let info = await f.store.getAccountInfo('alice-id');
  assert.equal(byId(info, a.key.id).used_today, 0);
  assert.equal(byId(info, a.key.id).unknown_requests_today, 0);
  assert.equal(byId(info, b.key.id).used_today, 1);
  assert.equal(info.usage.used_today, 1);
  assert.equal(f.state().usage['alice-id'].used_minute, 2);
  await f.store.settle(second.reservation, { input_tokens: 2, output_tokens: 3 });
  info = await f.store.getAccountInfo('alice-id');
  assert.equal(info.usage.total_tokens_today, 5);
});

test('expired tickets leave durable project unknowns and daily totals reset without retrospective guesses', async t => {
  const f = fixture(t);
  const a = await f.store.createKey('alice-id', 'Web');
  const pending = await f.store.reserve(a.api_key, details);
  f.setNow(f.now() + 601);
  const before = structuredClone(f.state());
  assert.equal((await f.store.getAccountInfo('alice-id')).keys[0].unknown_requests_today, 1);
  assert.deepEqual(f.state(), before, 'Read-only expiry coverage does not write the dashboard');
  await f.store.reserve(a.api_key, { consumeDaily: false });
  assert.equal(f.state().keys[hashToken(a.api_key)].usage.unknown_requests_today, 1);
  f.setNow(f.now() + 3000);
  await f.store.reserve(a.api_key, { consumeDaily: false });
  assert.equal(f.state().reservations[pending.reservation.id], undefined);
  assert.equal((await f.store.getAccountInfo('alice-id')).keys[0].unknown_requests_today, 1);
  await assert.rejects(f.store.settle(pending.reservation, { input_tokens: 2, output_tokens: 3 }), { code: 'invalid_reservation' });
  f.setNow(Math.ceil(f.now() / 86400) * 86400);
  const fresh = (await f.store.getAccountInfo('alice-id')).keys[0];
  assert.equal(fresh.used_today, 0);
  assert.equal(fresh.total_tokens_today, 0);
  assert.equal(fresh.unknown_requests_today, 0);
  assert.equal(fresh.accounting.status, 'complete');
});

test('project names and explicit ids are validated and ownership cannot be crossed', async t => {
  const f = fixture(t);
  const a = await f.store.createKey('alice-id', '  Web   sitesi  '), b = await f.store.createKey('bob-id', 'Özel');
  assert.equal(a.key.name, 'Web sitesi');
  for (const value of [null, 123, {}, [], '', ' ', 'x'.repeat(49), '<script>', 'A\nB', 'A\u202eB', a.api_key, 'sk-' + 'X'.repeat(32)]) {
    await assert.rejects(f.store.createKey('alice-id', value), { code: 'invalid_key_name' });
    await assert.rejects(f.store.renameKey('alice-id', a.key.id, value), { code: 'invalid_key_name' });
  }
  const before = structuredClone(f.state());
  await assert.rejects(f.store.revokeKey('alice-id', b.key.id), { status: 404, code: 'key_not_found' });
  await assert.rejects(f.store.renameKey('alice-id', b.key.id, 'Çalınmış'), { status: 404 });
  await assert.rejects(f.store.revokeKey('alice-id', hashToken(a.api_key)), { status: 400 });
  assert.deepEqual(f.state(), before);
  const renamed = await f.store.renameKey('alice-id', a.key.id, 'Üretim (web)');
  assert.equal(renamed.keys[0].name, 'Üretim (web)');
  assert.equal(renamed.keys[0].id, a.key.id);
  assert.equal((await f.store.authenticate(a.api_key)).ok, true);
  assert.equal((await f.store.getAccountInfo('bob-id')).keys[0].name, 'Özel');
});

test('project management API supports named create, rename and isolated revoke with CSRF protection', async t => {
  const f = fixture(t), handler = api(f);
  const create = async name => { const res = response(); await handler(request('POST', { name }), res); assert.equal(res.statusCode, 201); return JSON.parse(res.body); };
  const a = await create('Web sitesi'), b = await create('Codex');
  const before = structuredClone(f.state());
  const ambiguous = response(); await handler(request('DELETE'), ambiguous);
  assert.equal(ambiguous.statusCode, 409); assert.equal(JSON.parse(ambiguous.body).error.code, 'key_id_required');
  assert.deepEqual(f.state(), before);
  const renamed = response(); await handler(request('PATCH', { id: b.key.id, name: 'Test' }), renamed);
  assert.equal(renamed.statusCode, 200); assert.equal(byId(JSON.parse(renamed.body), b.key.id).name, 'Test');
  assert.equal(renamed.body.includes(b.api_key), false);
  const removed = response(); await handler(request('DELETE', { id: a.key.id }), removed);
  assert.equal(removed.statusCode, 204);
  assert.equal((await f.store.authenticate(a.api_key)).ok, false);
  assert.equal((await f.store.authenticate(b.api_key)).ok, true);
  for (const [method, body, headers, status] of [
    ['PATCH', { id: b.key.id, name: 'No' }, { origin: 'https://evil.example' }, 403],
    ['DELETE', { id: b.key.id }, { 'sec-fetch-site': 'cross-site' }, 403],
    ['PATCH', { id: b.key.id, name: 'No' }, { 'content-type': 'text/plain' }, 415],
    ['PATCH', { id: b.key.id }, {}, 400],
    ['PATCH', { id: b.key.id, name: 'Test', user_id: 'bob-id' }, {}, 400],
    ['POST', { name: 'Test', id: b.key.id }, {}, 400],
    ['DELETE', { id: b.key.id, all: true }, {}, 400],
  ]) { const res = response(); await handler(request(method, body, headers), res); assert.equal(res.statusCode, status); }
  assert.equal((await f.store.authenticate(b.api_key)).ok, true);
  const single = response(); await handler(request('DELETE', ''), single); assert.equal(single.statusCode, 204);
  assert.equal((await f.store.getAccountInfo('alice-id')).keys.length, 0);
  assert.equal(Object.keys(f.state().keys).length, 0, 'Unused revoked keys must not grow storage on repeated replacement');
});

test('request activity and per-key usage share existing storage writes and never capture request content', async t => {
  const f = fixture(t), created = await f.store.createKey('alice-id', 'Codex');
  const before = f.writes();
  const access = await f.store.reserve(created.api_key, { estimatedTokens: 100, request: {
    model: 'gpt-6.1-sol', endpoint: 'v1/responses', prompt: 'PRIVATE_PROMPT_MUST_NOT_PERSIST',
    api_key: created.api_key, password: 'PRIVATE_PASSWORD_MUST_NOT_PERSIST',
  } });
  assert.equal(f.writes(), before + 1);
  await f.store.settle(access.reservation, { input_tokens: 6, output_tokens: 4 }, { response_id: 'resp_safe',
    activity: { status: 'success', http_status: 200, latency_ms: 1234, response: 'PRIVATE_RESPONSE_MUST_NOT_PERSIST' } });
  assert.equal(f.writes(), before + 2);
  const history = queryHistory(f.state(), 'alice-id', {}, f.now() * 1000);
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].key_id, created.key.id);
  assert.equal(history.items[0].key_name, 'Codex');
  assert.equal(history.items[0].total_tokens, 10);
  assert.equal(history.items[0].latency_ms, 1234);
  assert.equal(history.items[0].response_id, 'resp_safe');
  const publicOutput = JSON.stringify({ history, account: await f.store.getAccountInfo('alice-id') });
  for (const secret of [created.api_key, hashToken(created.api_key), 'PRIVATE_PROMPT_MUST_NOT_PERSIST', 'PRIVATE_PASSWORD_MUST_NOT_PERSIST', 'PRIVATE_RESPONSE_MUST_NOT_PERSIST']) {
    assert.equal(publicOutput.includes(secret), false);
  }
  assert.equal(JSON.stringify(f.state()).includes('PRIVATE_'), false);
});
