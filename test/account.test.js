const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createAuth } = require("../lib/auth");
const { accountInfoFromState } = require("../lib/key-store");
const { createHandler } = require("../api/account");
const authApi = require("../api/auth");

const token = "s".repeat(43);
const digest = crypto.createHash("sha256").update(token).digest("hex");
const now = Math.floor(Date.now() / 1000);
const hour = Math.floor(now / 3600);
const day = Math.floor(now / 86400);
const week = Math.floor((day + 3) / 7);

function fixture() {
  const state = { users: { member: { id: "private-user-id", username: "Member", role: "user", enabled: true,
    hourly_limit: 20, daily_limit: 50, weekly_limit: 200, requests_per_minute: 5,
    session_version: 3, password_hash: "private-password-hash", created_at: "2026-11-20T00:00:00.000Z" } },
  sessions: { [digest]: { user_id: "private-user-id", version: 3, expires_at: now + 3600 } },
  keys: { "private-api-key-hash": { user_id: "private-user-id", prefix: "kly_prefix12", created_at: now - 10, expires_at: now + 86400 } },
  usage: { "private-user-id": { hour, day, week, used_this_hour: 2, used_today: 7, used_this_week: 24 } } };
  let reads = 0;
  let writes = 0;
  const auth = createAuth({ readState: async () => { reads++; return structuredClone(state); },
    mutateState: async () => { writes++; throw new Error("This endpoint must not write"); } });
  return { state, auth, handler: createHandler(auth), reads: () => reads, writes: () => writes };
}

function req(method = "GET", cookie = `kly_auth=${token}`) { return { method, headers: { cookie } }; }
function response() {
  return { statusCode: 200, headers: {}, body: "", setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value || ""; } };
}

test("account bootstrap authenticates and returns usage from exactly one storage read without exposing private data", async () => {
  const f = fixture();
  const res = response();
  await f.handler(req(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(f.reads(), 1);
  assert.equal(f.writes(), 0);
  const body = JSON.parse(res.body);
  assert.equal(body.user.username, "Member");
  assert.equal(body.key.prefix, "kly_prefix12");
  assert.equal(body.limits.daily_tokens, 1_000_000_000);
  assert.equal(body.user.daily_tokens, 1_000_000_000);
  assert.equal(body.usage.remaining_tokens_today, 1_000_000_000);
  assert.equal(body.usage.used_today, 7);
  assert.equal(body.usage.used_this_week, 24);
  assert.equal(body.service.model, "gpt-6.1-sol");
  for (const secret of [token, digest, "private-user-id", "private-password-hash", "private-api-key-hash", "session_version"]) {
    assert.equal(res.body.includes(secret), false, `response must exclude ${secret}`);
  }
  assert.equal(res.headers["cache-control"], "private, no-store");
  assert.equal(res.headers.vary, "Cookie, Origin");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["set-cookie"], undefined);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("account bootstrap fails closed for missing, expired, disabled, deleted and invalidated sessions", async () => {
  for (const invalidate of [
    (f) => { f.state.sessions = {}; },
    (f) => { f.state.sessions[digest].expires_at = now - 1; },
    (f) => { f.state.users.member.enabled = false; },
    (f) => { delete f.state.users.member; },
    (f) => { f.state.users.member.session_version++; },
  ]) {
    const f = fixture();
    invalidate(f);
    const res = response();
    await f.handler(req(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, "unauthorized");
    assert.equal(f.reads(), 1);
    assert.equal(f.writes(), 0);
    assert.equal(res.body.includes("Member"), false);
  }
  const f = fixture();
  const res = response();
  await f.handler(req("GET", ""), res);
  assert.equal(res.statusCode, 401);
  assert.equal(f.reads(), 0, "a missing or malformed cookie needs no storage lookup");
});

test("account bootstrap rejects writes and masks storage diagnostics", async () => {
  const f = fixture();
  const rejected = response();
  await f.handler(req("POST"), rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, "GET");
  assert.equal(f.reads(), 0);
  assert.equal(f.writes(), 0);
  const failure = response();
  await createHandler(createAuth({ readState: async () => { throw new Error("private storage diagnostics"); } }))(req(), failure);
  assert.equal(failure.statusCode, 503);
  assert.equal(JSON.parse(failure.body).error.code, "storage_unavailable");
  assert.equal(failure.body.includes("private storage diagnostics"), false);
});

test("account reset metadata reports exact upcoming UTC boundaries and does not modify the snapshot", () => {
  const f = fixture();
  const before = structuredClone(f.state);
  const nearMonday = Math.floor(Date.parse("2026-11-22T23:59:59Z") / 1000);
  const info = accountInfoFromState(f.state, "private-user-id", nearMonday);
  assert.equal(info.usage.server_time, "2026-11-22T23:59:59.000Z");
  assert.equal(info.usage.hour_resets_at, "2026-11-23T00:00:00.000Z");
  assert.equal(info.usage.day_resets_at, "2026-11-23T00:00:00.000Z");
  assert.equal(info.usage.week_resets_at, "2026-11-23T00:00:00.000Z");
  const monday = accountInfoFromState(f.state, "private-user-id", nearMonday + 1);
  assert.equal(monday.usage.hour_resets_at, "2026-11-23T01:00:00.000Z");
  assert.equal(monday.usage.day_resets_at, "2026-11-24T00:00:00.000Z");
  assert.equal(monday.usage.week_resets_at, "2026-11-30T00:00:00.000Z");
  assert.deepEqual(f.state, before);
});

test("legacy auth GET keeps its user-only response contract", async () => {
  const f = fixture();
  const res = response();
  await authApi.createHandler(f.auth)(req(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(JSON.parse(res.body)), ["user"]);
  assert.equal(JSON.parse(res.body).user.username, "Member");
});
