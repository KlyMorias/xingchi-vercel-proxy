const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeyStore, hashToken } = require("../lib/key-store.js");
const { createStateStore } = require("../lib/state-store.js");
const { createHandler } = require("../api/keys.js");

function seed() {
  return { version: 1, users: { alice: { id: "user-alice", username: "alice", role: "user", enabled: true,
    hourly_limit: 20, daily_limit: 50, weekly_limit: 200, requests_per_minute: 5 }, bob: { id: "user-bob", username: "bob", role: "user", enabled: true,
    hourly_limit: 20, daily_limit: 50, weekly_limit: 200, requests_per_minute: 5 } }, sessions: {}, keys: {}, usage: {}, reservations: {}, login_attempts: {} };
}
function fixture() {
  let state = seed();
  let version = 0;
  let now = Math.floor(Date.now() / 1000);
  const client = {
    async get(_path, options) {
      assert.equal(options.access, "private");
      assert.equal(options.useCache, false);
      const snapshot = JSON.stringify(state);
      const etag = `v${version}`;
      await Promise.resolve();
      return { statusCode: 200, blob: { etag, size: Buffer.byteLength(snapshot) },
        stream: new Response(snapshot).body };
    },
    async put(_path, text, options) {
      await Promise.resolve();
      if (options.ifMatch !== `v${version}`) throw new Error("Precondition failed");
      state = JSON.parse(text);
      version++;
      return { etag: `v${version}` };
    },
  };
  const storage = createStateStore(client, { attempts: 30, pause: async () => {} });
  return { store: createKeyStore(storage, { now: () => now }), state: () => state,
    change(callback) { callback(state); version++; }, setNow(value) { now = value; } };
}
const originalEnv = { ...process.env };
test.beforeEach(() => { process.env.BLOB_STORE_ID = "store_test"; });
test.afterEach(() => { process.env = { ...originalEnv }; });

function response() {
  return { statusCode: 200, headers: {}, body: "", setHeader(name, value) { this.headers[name.toLowerCase()] = value; }, end(body) { this.body = body || ""; } };
}
function request({ method = "GET", body = "{}", headers = {} } = {}) {
  return { method, headers: { host: "klyapi.vercel.app", origin: "https://klyapi.vercel.app", "content-type": "application/json", ...headers },
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
}
function api(f) { return createHandler(f.store, { async requireUser() { return { id: "user-alice" }; } }); }

test("API tokens are shown once and only their hashes and prefixes are persisted", async () => {
  const f = fixture();
  const created = await f.store.createKey("user-alice");
  assert.match(created.api_key, /^kly_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.prefix, created.api_key.slice(0, 12));
  assert.ok(f.state().keys[hashToken(created.api_key)]);
  assert.equal(JSON.stringify(f.state()).includes(created.api_key), false);
  assert.equal(Date.parse(created.key.expires_at) - Date.parse(created.key.created_at), 30 * 86400000);
  assert.deepEqual(await f.store.getSession("user-alice"), created.key);
  await assert.rejects(f.store.createKey("user-alice"), { status: 409 });
  assert.equal((await f.store.getAccountInfo("user-bob")).key, null);
});

test("simultaneous creations allow only one active key through Blob ETag CAS", async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.store.createKey("user-alice"), f.store.createKey("user-alice")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(Object.keys(f.state().keys).length, 1);
});

test("concurrent admissions never exceed the per-account minute limit", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const admissions = await Promise.all(Array.from({ length: 12 }, () => f.store.reserve(api_key)));
  assert.equal(admissions.filter((r) => r.ok).length, 5);
  assert.equal(admissions.filter((r) => r.code === "rate_limited").length, 7);
  assert.equal(f.state().usage["user-alice"].used_today, 5);
  assert.equal(f.state().usage["user-alice"].used_minute, 5);
});

test("hourly and weekly caps are enforced on billable calls while model lists preserve production quotas", async () => {
  const hourly = fixture();
  hourly.change((state) => { state.users.alice.hourly_limit = 2; state.users.alice.requests_per_minute = 10; });
  const { api_key } = await hourly.store.createKey("user-alice");
  assert.equal((await hourly.store.reserve(api_key)).ok, true);
  assert.equal((await hourly.store.reserve(api_key)).ok, true);
  const hourlyExhausted = await hourly.store.reserve(api_key);
  assert.equal(hourlyExhausted.code, "hourly_limit_exceeded");
  assert.ok(hourlyExhausted.retryAfter > 0);

  const weekly = fixture();
  weekly.change((state) => { state.users.alice.weekly_limit = 2; state.users.alice.requests_per_minute = 10; });
  const weeklyKey = (await weekly.store.createKey("user-alice")).api_key;
  assert.equal((await weekly.store.reserve(weeklyKey)).ok, true);
  assert.equal((await weekly.store.reserve(weeklyKey)).ok, true);
  const weeklyExhausted = await weekly.store.reserve(weeklyKey);
  assert.equal(weeklyExhausted.code, "weekly_limit_exceeded");
  assert.ok(weeklyExhausted.retryAfter > 0);
  const modelList = await weekly.store.reserve(weeklyKey, { consumeDaily: false });
  assert.equal(modelList.ok, true);
  assert.equal(modelList.reservation, null);
  assert.equal(weekly.state().usage["user-alice"].used_this_week, 2);
});

test("hour, day and Monday-based week usage reset and old refunds do not touch new windows", async () => {
  const f = fixture();
  const monday = Math.floor(Date.parse("2026-11-16T00:10:00Z") / 1000);
  f.setNow(monday);
  const { api_key } = await f.store.createKey("user-alice");
  const old = await f.store.reserve(api_key);
  f.setNow(monday + 8 * 86400);
  const current = await f.store.reserve(api_key);
  await f.store.release(old.reservation);
  assert.equal(f.state().usage["user-alice"].used_this_hour, 1);
  assert.equal(f.state().usage["user-alice"].used_today, 1);
  assert.equal(f.state().usage["user-alice"].used_this_week, 1);
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.used_this_week, 1);
  await f.store.release(current.reservation);
  assert.deepEqual((await f.store.getAccountInfo("user-alice")).usage,
    { used_this_hour: 0, remaining_this_hour: 20, used_today: 0, remaining_today: 50, used_this_week: 0, remaining_this_week: 200,
      hour_resets_at: "2026-11-24T01:00:00.000Z", day_resets_at: "2026-11-25T00:00:00.000Z",
      week_resets_at: "2026-11-30T00:00:00.000Z", server_time: "2026-11-24T00:10:00.000Z" });
});

test("daily cap is account-based, persists after rotation and is independent from models listing", async () => {
  const f = fixture();
  f.change((state) => { state.users.alice.daily_limit = 2; });
  const first = await f.store.createKey("user-alice");
  await f.store.reserve(first.api_key);
  await f.store.revokeKey("user-alice");
  const second = await f.store.createKey("user-alice");
  assert.equal(second.key.used_today, 1);
  assert.equal((await f.store.reserve(first.api_key)).status, 401);
  assert.equal((await f.store.reserve(second.api_key)).ok, true);
  const exhausted = await f.store.reserve(second.api_key);
  assert.equal(exhausted.code, "daily_limit_exceeded");
  assert.ok(exhausted.retryAfter > 0);
  const models = await f.store.reserve(second.api_key, { consumeDaily: false });
  assert.equal(models.ok, true);
  assert.equal(models.reservation, null);
  assert.equal(models.usedToday, 2);
  assert.equal((await f.store.getAccountInfo("user-alice")).limits.daily_requests, 2);
});

test("refund tickets are idempotent and do not refund minute rate consumption", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const admitted = await f.store.reserve(api_key);
  await Promise.all([f.store.release(admitted.reservation), f.store.release(admitted.reservation)]);
  assert.equal(f.state().usage["user-alice"].used_today, 0);
  assert.equal(f.state().usage["user-alice"].used_minute, 1);
  assert.equal(Object.keys(f.state().reservations).length, 0);
});

test("disabled, deleted, expired and revoked keys cannot spend provider quota", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  f.change((state) => { state.users.alice.enabled = false; });
  assert.equal((await f.store.reserve(api_key)).code, "account_disabled");
  await assert.rejects(f.store.createKey("user-alice"), { status: 401 });
  f.change((state) => { state.users.alice.enabled = true; state.keys[hashToken(api_key)].expires_at = 1; });
  assert.equal((await f.store.reserve(api_key)).status, 401);
  f.change((state) => { delete state.users.alice; });
  assert.equal((await f.store.reserve(api_key)).status, 401);
  assert.equal(Object.keys(f.state().usage).length, 0);
});

test("key-management API requires approved login and never creates anonymous cookies", async () => {
  const f = fixture();
  const handler = createHandler(f.store, { async requireUser() { throw Object.assign(new Error("Giriş yapmalısınız."), { status: 401, code: "unauthorized" }); } });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(Object.keys(f.state().keys).length, 0);
});

test("authenticated key API creates, reports account limits and revokes the key", async () => {
  const f = fixture();
  f.change((state) => { state.users.alice.daily_limit = 17; });
  const handler = api(f);
  const created = response();
  await handler(request({ method: "POST" }), created);
  assert.equal(created.statusCode, 201);
  const payload = JSON.parse(created.body);
  assert.match(payload.api_key, /^kly_/);
  assert.equal(payload.limits.daily_requests, 17);
  const read = response();
  await handler(request(), read);
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.includes(payload.api_key), false);
  assert.equal(JSON.parse(read.body).key.prefix, payload.key.prefix);
  assert.equal(JSON.parse(read.body).limits.hourly_requests, 20);
  assert.equal(JSON.parse(read.body).limits.weekly_requests, 200);
  const removed = response();
  await handler(request({ method: "DELETE" }), removed);
  assert.equal(removed.statusCode, 204);
  assert.equal((await f.store.reserve(payload.api_key)).status, 401);
});

test("management mutations enforce origin, JSON and body limit", async () => {
  const f = fixture();
  const handler = api(f);
  for (const [req, status] of [
    [request({ method: "POST", headers: { origin: "https://evil.example" } }), 403],
    [request({ method: "DELETE", headers: { origin: undefined } }), 403],
    [request({ method: "POST", headers: { "content-type": "text/plain" } }), 415],
    [request({ method: "POST", body: "[]" }), 400],
    [request({ method: "POST", body: JSON.stringify({ data: "x".repeat(1024) }) }), 413],
  ]) {
    const res = response(); await handler(req, res); assert.equal(res.statusCode, status);
  }
  assert.equal(Object.keys(f.state().keys).length, 0);
});

test("Blob failure remains fail-closed and never leaks SDK error details", async () => {
  const failStore = createKeyStore({ isConfigured: () => true,
    async readState() { throw new Error("private blob credentials"); },
    async mutateState() { throw Object.assign(new Error("private blob credentials"), { status: 503 }); } });
  const handler = createHandler(failStore, { async requireUser() { return { id: "user-alice" }; } });
  const res = response(); await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.includes("private blob credentials"), false);
  await assert.rejects(failStore.reserve(`kly_${"x".repeat(43)}`), { status: 503 });
});
