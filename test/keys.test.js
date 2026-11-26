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
function fixture(context) {
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
  // Capture real operation deadlines above; cleanup follows the simulated clock.
  context?.mock.method(Date, "now", () => now * 1000);
  return { store: createKeyStore(storage, { now: () => now }), state: () => state,
    anotherInstance: () => createKeyStore(createStateStore(client, { attempts: 30, pause: async () => {} }), { now: () => now }),
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
  const second = await f.store.createKey("user-alice", "Codex");
  assert.equal(second.keys.length, 2);
  assert.equal(second.key.name, "Codex");
  assert.equal(second.key.prefix, second.api_key.slice(0, 12));
  assert.equal((await f.store.getAccountInfo("user-bob")).key, null);
});

test("simultaneous creations enforce ten active project keys through Blob ETag CAS", async () => {
  const f = fixture();
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => f.store.createKey("user-alice", "Proje " + index)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  assert.equal(results.find((r) => r.status === "rejected").reason.status, 409);
  assert.equal(Object.keys(f.state().keys).length, 10);
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

test("legacy request caps do not restrict the free token plan and model lists reserve no tokens", async () => {
  const f = fixture();
  f.change((state) => { state.users.alice.hourly_limit = 0; state.users.alice.daily_limit = 0;
    state.users.alice.weekly_limit = 0; state.users.alice.requests_per_minute = 10; });
  const { api_key } = await f.store.createKey("user-alice");
  assert.equal((await f.store.reserve(api_key, { estimatedTokens: 1000 })).ok, true);
  assert.equal((await f.store.reserve(api_key, { estimatedTokens: 2000 })).ok, true);
  const modelList = await f.store.reserve(api_key, { consumeDaily: false });
  assert.equal(modelList.ok, true);
  assert.equal(modelList.reservation, null);
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.limits.daily_tokens, 1_000_000_000);
  assert.equal(info.usage.reserved_tokens_today, 3000);
  assert.equal(info.usage.total_tokens_today, 0);
  assert.equal(info.usage.used_this_week, 2);
});

test("hour, day and Monday-based week usage reset and old refunds do not touch new windows", async (context) => {
  const f = fixture(context);
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
    { used_this_hour: 0, used_today: 0, used_this_week: 0,
      input_tokens_today: 0, output_tokens_today: 0, total_tokens_today: 0, reserved_tokens_today: 0, remaining_tokens_today: 1_000_000_000,
      accounting: { source: "provider_usage", status: "complete", quota_scope: "application_daily", provider_balance: null,
        provider_balance_status: "not_exposed", reserved_kind: "admission_estimate", unknown_requests_today: 0,
        legacy_usage_unknown: false, last_settlement: null },
      hour_resets_at: "2026-11-24T01:00:00.000Z", day_resets_at: "2026-11-25T00:00:00.000Z",
      week_resets_at: "2026-11-30T00:00:00.000Z", server_time: "2026-11-24T00:10:00.000Z" });
});

test("daily tokens are account-based, persist after rotation and are independent from models listing", async () => {
  const f = fixture();
  f.change((state) => { state.users.alice.daily_limit = 2; });
  const first = await f.store.createKey("user-alice");
  const charged = await f.store.reserve(first.api_key, { estimatedTokens: 999_999_998 });
  await f.store.settle(charged.reservation, { input_tokens: 999_999_990, output_tokens: 8 });
  await f.store.revokeKey("user-alice");
  const second = await f.store.createKey("user-alice");
  assert.equal(second.key.used_today, 1);
  assert.equal(second.key.total_tokens_today, 999_999_998);
  assert.equal((await f.store.reserve(first.api_key)).status, 401);
  assert.equal((await f.store.reserve(second.api_key, { estimatedTokens: 2 })).ok, true);
  const exhausted = await f.store.reserve(second.api_key);
  assert.equal(exhausted.code, "daily_token_limit_exceeded");
  assert.ok(exhausted.retryAfter > 0);
  const models = await f.store.reserve(second.api_key, { consumeDaily: false });
  assert.equal(models.ok, true);
  assert.equal(models.reservation, null);
  assert.equal(models.usedToday, 2);
  assert.equal((await f.store.getAccountInfo("user-alice")).limits.daily_tokens, 1_000_000_000);
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

test("concurrent token reservations across server instances cannot overspend the daily balance", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const other = f.anotherInstance();
  const admitted = await Promise.all([
    f.store.reserve(api_key, { estimatedTokens: 400_000_000 }),
    other.reserve(api_key, { estimatedTokens: 400_000_000 }),
    f.store.reserve(api_key, { estimatedTokens: 400_000_000 }),
  ]);
  assert.equal(admitted.filter((result) => result.ok).length, 2);
  assert.equal(admitted.filter((result) => result.code === "daily_token_limit_exceeded").length, 1);
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.reserved_tokens_today, 800_000_000);
  assert.equal(info.usage.remaining_tokens_today, 200_000_000);
});

test("settlement counts actual input plus output once, without adding cached or reasoning subsets", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  const usage = { input_tokens: 100, output_tokens: 50, total_tokens: 150,
    input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 40 } };
  await Promise.all([f.store.settle(access.reservation, usage), f.store.settle(access.reservation, usage)]);
  await f.store.release(access.reservation);
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.input_tokens_today, 100);
  assert.equal(info.usage.output_tokens_today, 50);
  assert.equal(info.usage.total_tokens_today, 150);
  assert.equal(info.usage.reserved_tokens_today, 0);
  assert.equal(info.usage.remaining_tokens_today, 999_999_850);
  assert.equal(info.usage.used_today, 1);
});

test("a failed call releases only its own token hold and keeps the minute abuse throttle", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const first = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  const second = await f.store.reserve(api_key, { estimatedTokens: 500 });
  await Promise.all([f.store.release(first.reservation), f.store.release(first.reservation)]);
  await f.store.settle(second.reservation, { input_tokens: 100, output_tokens: 20 });
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.total_tokens_today, 120);
  assert.equal(info.usage.reserved_tokens_today, 0);
  assert.equal(info.usage.used_today, 1);
  assert.equal(f.state().usage["user-alice"].used_minute, 2);
});

test("invalid usage or reservation amounts cannot remove a hold or corrupt counters", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  for (const estimatedTokens of [0, -1, 0.5, NaN, Infinity, "100", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.store.reserve(api_key, { estimatedTokens }), { code: "invalid_token_reservation" });
  }
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: 10 },
    { input_tokens: 1, output_tokens: 0.5 }, { input_tokens: "10", output_tokens: 2 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }, { input_tokens: 10, output_tokens: 2, total_tokens: 999 },
    { input_tokens: 10, output_tokens: 2, output_tokens_details: { reasoning_tokens: 3 } }]) {
    await assert.rejects(f.store.settle(access.reservation, usage), { code: "invalid_token_usage" });
  }
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.reserved_tokens_today, 1000);
  assert.equal(info.usage.total_tokens_today, 0);
  assert.equal(Object.keys(f.state().reservations).length, 1);
});

test("expired holds stop restricting quota without requiring a dashboard write", async (context) => {
  const f = fixture(context);
  const { api_key } = await f.store.createKey("user-alice");
  await f.store.reserve(api_key, { estimatedTokens: 1_000_000_000 });
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.remaining_tokens_today, 0);
  f.setNow(Math.floor(Date.now() / 1000) + 601);
  const before = structuredClone(f.state());
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.remaining_tokens_today, 1_000_000_000);
  assert.equal(info.usage.reserved_tokens_today, 0);
  assert.equal(info.usage.accounting.status, "partial");
  assert.equal(info.usage.accounting.unknown_requests_today, 1);
  assert.deepEqual(f.state(), before);
  assert.equal((await f.store.reserve(api_key, { estimatedTokens: 1_000_000_000 })).ok, true);
});

test("late actual settlement survives hold expiry and clears an expired unknown exactly once", async (context) => {
  const f = fixture(context);
  const start = Math.floor(Date.parse("2026-11-25T12:00:00Z") / 1000);
  f.setNow(start);
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  f.setNow(start + 601);
  const before = structuredClone(f.state());
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.accounting.unknown_requests_today, 1);
  assert.deepEqual(f.state(), before, "unknown expiry must also be visible on a read-only dashboard");
  await Promise.all([f.store.markUnknown(access.reservation), f.store.markUnknown(access.reservation)]);
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.accounting.unknown_requests_today, 1);
  const actual = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };
  const details = { response_id: "resp_real", model: "provider-reported-model" };
  await Promise.all([f.store.settle(access.reservation, actual, details), f.store.settle(access.reservation, actual, details)]);
  await f.store.markUnknown(access.reservation);
  await f.store.release(access.reservation);
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.total_tokens_today, 30);
  assert.equal(info.usage.reserved_tokens_today, 0);
  assert.equal(info.usage.accounting.status, "complete");
  assert.equal(info.usage.accounting.unknown_requests_today, 0);
  assert.equal(info.usage.used_today, 1);
  assert.deepEqual(info.usage.accounting.last_settlement, {
    recorded_at: "2026-11-25T12:10:01.000Z", response_id: "resp_real", model: "provider-reported-model", ...actual });
  await assert.rejects(f.store.settle(access.reservation, { input_tokens: 21, output_tokens: 10 }),
    { code: "conflicting_token_usage" });
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.total_tokens_today, 30);
});

test("unknown consumption is durable across key rotation and never charges an admission estimate", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const first = await f.store.reserve(api_key, { estimatedTokens: 999999 });
  await Promise.all([f.store.markUnknown(first.reservation), f.store.markUnknown(first.reservation)]);
  await f.store.revokeKey("user-alice");
  const rotated = await f.store.createKey("user-alice");
  assert.equal(rotated.usage.total_tokens_today, 0);
  assert.equal(rotated.usage.reserved_tokens_today, 0);
  assert.equal(rotated.usage.remaining_tokens_today, 1_000_000_000);
  assert.equal(rotated.usage.accounting.unknown_requests_today, 1);
  assert.equal(rotated.usage.accounting.status, "partial");
  assert.equal(rotated.usage.accounting.provider_balance, null);
  assert.equal(rotated.usage.accounting.provider_balance_status, "not_exposed");
});

test("an unknown marker racing with another instance's actual settlement cannot hide or double count usage", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  await Promise.all([f.store.markUnknown(access.reservation),
    f.anotherInstance().settle(access.reservation, { input_tokens: 20, output_tokens: 10 })]);
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.total_tokens_today, 30);
  assert.equal(usage.accounting.status, "complete");
  assert.equal(usage.accounting.unknown_requests_today, 0);
});

test("settlement receipt retention stays bounded without turning recorded usage into an unknown", async (context) => {
  const f = fixture(context);
  const start = Math.floor(Date.parse("2026-11-25T12:00:00Z") / 1000);
  f.setNow(start);
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  await f.store.settle(access.reservation, { input_tokens: 20, output_tokens: 10 });
  f.setNow(start + 601);
  await f.store.reserve(api_key, { consumeDaily: false });
  assert.equal(f.state().reservations[access.reservation.id], undefined);
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.total_tokens_today, 30);
  assert.equal(usage.accounting.unknown_requests_today, 0);
  assert.equal(usage.accounting.status, "complete");
  await assert.rejects(f.store.settle(access.reservation, { input_tokens: 20, output_tokens: 10 }), { code: "invalid_reservation" });
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.total_tokens_today, 30);
});

test("legacy unknown usage stays partial after current token fields are initialized by a new admission", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  f.change((state) => { state.usage["user-alice"] = { day: Math.floor(Date.now() / 86400000), used_today: 2 }; });
  await f.store.reserve(api_key, { consumeDaily: false });
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.input_tokens_today, 0);
  assert.equal(usage.output_tokens_today, 0);
  assert.equal(usage.accounting.status, "partial");
  assert.equal(usage.accounting.legacy_usage_unknown, true);
});

test("pruned unresolved tickets leave durable unknowns and cannot silently accept a late settlement", async (context) => {
  const f = fixture(context);
  const start = Math.floor(Date.parse("2026-11-25T12:00:00Z") / 1000);
  f.setNow(start);
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  f.setNow(start + 3601);
  // A successful mutation persists unknown usage before pruning the old ticket.
  await f.store.reserve(api_key, { consumeDaily: false });
  assert.equal(f.state().reservations[access.reservation.id], undefined);
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.accounting.unknown_requests_today, 1);
  assert.equal(usage.accounting.status, "partial");
  assert.equal(usage.total_tokens_today, 0);
  await assert.rejects(f.store.settle(access.reservation, { input_tokens: 20, output_tokens: 10 }), { code: "invalid_reservation" });
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.accounting.unknown_requests_today, 1);
});

test("legacy token tickets retain their old hold deadline but accept late actual settlement", async (context) => {
  const f = fixture(context);
  const start = Math.floor(Date.parse("2026-11-25T12:00:00Z") / 1000);
  f.setNow(start);
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  f.change((state) => {
    const ticket = state.reservations[access.reservation.id];
    ticket.expires_at = ticket.hold_expires_at;
    delete ticket.hold_expires_at;
  });
  f.setNow(start + 601);
  await f.store.settle(access.reservation, { input_tokens: 20, output_tokens: 10 });
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.total_tokens_today, 30);
  assert.equal(usage.accounting.unknown_requests_today, 0);
  assert.equal(usage.accounting.status, "complete");
  assert.equal(usage.accounting.last_settlement.model, null);
  assert.equal(usage.accounting.last_settlement.response_id, null);
});

test("unknown counters reset at UTC midnight without hiding known last settlement metadata", async (context) => {
  const f = fixture(context);
  const midnight = Math.floor(Date.parse("2026-11-26T00:00:00Z") / 1000);
  f.setNow(midnight - 10);
  const { api_key } = await f.store.createKey("user-alice");
  const known = await f.store.reserve(api_key);
  await f.store.settle(known.reservation, { input_tokens: 2, output_tokens: 3 });
  const unknown = await f.store.reserve(api_key);
  await f.store.markUnknown(unknown.reservation);
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.accounting.status, "partial");
  f.setNow(midnight);
  const usage = (await f.store.getAccountInfo("user-alice")).usage;
  assert.equal(usage.total_tokens_today, 0);
  assert.equal(usage.accounting.unknown_requests_today, 0);
  assert.equal(usage.accounting.status, "complete");
  assert.equal(usage.accounting.last_settlement.total_tokens, 5);
});

test("daily token counters reset at UTC midnight and late prior-day settlement never charges the new day", async (context) => {
  const f = fixture(context);
  const midnight = Math.floor(Date.parse("2026-11-26T00:00:00Z") / 1000);
  f.setNow(midnight - 10);
  const { api_key } = await f.store.createKey("user-alice");
  const first = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  await f.store.settle(first.reservation, { input_tokens: 100, output_tokens: 50 });
  const late = await f.store.reserve(api_key, { estimatedTokens: 500 });
  assert.equal((await f.store.getAccountInfo("user-alice")).usage.total_tokens_today, 150);
  f.setNow(midnight);
  await f.store.settle(late.reservation, { input_tokens: 200, output_tokens: 20 });
  const fresh = await f.store.reserve(api_key, { estimatedTokens: 100 });
  await f.store.settle(fresh.reservation, { input_tokens: 15, output_tokens: 10 });
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.total_tokens_today, 25);
  assert.equal(info.usage.remaining_tokens_today, 999_999_975);
  assert.equal(info.usage.day_resets_at, "2026-11-27T00:00:00.000Z");
});

test("actual usage above the reservation is recorded and prevents further daily spending", async () => {
  const f = fixture();
  const { api_key } = await f.store.createKey("user-alice");
  const access = await f.store.reserve(api_key, { estimatedTokens: 1000 });
  await f.store.settle(access.reservation, { input_tokens: 1_000_000_000, output_tokens: 50 });
  const info = await f.store.getAccountInfo("user-alice");
  assert.equal(info.usage.total_tokens_today, 1_000_000_050);
  assert.equal(info.usage.remaining_tokens_today, 0);
  assert.equal((await f.store.reserve(api_key)).code, "daily_token_limit_exceeded");
  assert.equal((await f.store.reserve(api_key, { consumeDaily: false })).ok, true);
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
  assert.equal(payload.limits.daily_tokens, 1_000_000_000);
  assert.equal(payload.usage.remaining_tokens_today, 1_000_000_000);
  assert.equal(payload.usage.reserved_tokens_today, 0);
  const read = response();
  await handler(request(), read);
  assert.equal(read.statusCode, 200);
  assert.equal(read.body.includes(payload.api_key), false);
  assert.equal(JSON.parse(read.body).key.prefix, payload.key.prefix);
  assert.equal(JSON.parse(read.body).limits.requests_per_minute, 5);
  assert.equal(JSON.parse(read.body).limits.hourly_requests, undefined);
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
