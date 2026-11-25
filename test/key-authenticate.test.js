const test = require("node:test");
const assert = require("node:assert/strict");
const { createKeyStore, hashToken } = require("../lib/key-store");

const token = `kly_${"A".repeat(43)}`;
const digest = hashToken(token);

function fixture() {
  let now = 1_795_600_000;
  let reads = 0;
  let writes = 0;
  const state = { version: 1,
    users: { alice: { id: "user-alice", username: "alice", enabled: true, role: "user",
      password_hash: "private-password-hash", requests_per_minute: 5 } },
    keys: { [digest]: { user_id: "user-alice", prefix: token.slice(0, 12), expires_at: now + 60 } },
    usage: {}, reservations: {}, sessions: {}, login_attempts: {} };
  const store = createKeyStore({ isConfigured: () => true,
    async readState() { reads++; return state; },
    async mutateState(callback) { writes++; return callback(state); } }, { now: () => now });
  return { store, state, reads: () => reads, writes: () => writes, setNow(value) { now = value; }, now: () => now };
}

test("large-upload authentication reads once, returns no account data, and never changes quota", async () => {
  const f = fixture();
  // Admission limits are checked by reserve(), not by this authentication read.
  f.state.usage["user-alice"] = { minute: Math.floor(f.now() / 60), used_minute: 5,
    day: Math.floor(f.now() / 86400), input_tokens_today: 1_000_000_000, output_tokens_today: 0 };
  const before = JSON.stringify(f.state);
  assert.deepEqual(await f.store.authenticate(token), { ok: true });
  assert.equal(f.reads(), 1);
  assert.equal(f.writes(), 0);
  assert.equal(JSON.stringify(f.state), before);
});

test("malformed upload keys are rejected without reading storage", async () => {
  const f = fixture();
  for (const value of [undefined, null, {}, [], 123, "", "kly_short", "sk-provider-key", token + "\n", [token]]) {
    assert.deepEqual(await f.store.authenticate(value), { ok: false, status: 401,
      code: "invalid_api_key", message: "API anahtarı geçersiz veya iptal edilmiş." });
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.writes(), 0);
});

test("unknown, revoked, expired and invalid-expiry keys cannot authorize an upload", async () => {
  for (const change of [
    f => { delete f.state.keys[digest]; },
    f => { f.state.keys[digest].revoked_at = f.now() - 1; },
    f => { f.state.keys[digest].expires_at = f.now() - 1; },
    f => { f.state.keys[digest].expires_at = f.now(); },
    f => { delete f.state.keys[digest].expires_at; },
    f => { f.state.keys[digest].expires_at = String(f.now() + 60); },
  ]) {
    const f = fixture();
    change(f);
    assert.deepEqual(await f.store.authenticate(token), { ok: false, status: 401,
      code: "invalid_api_key", message: "API anahtarı geçersiz veya iptal edilmiş." });
    assert.equal(f.reads(), 1);
    assert.equal(f.writes(), 0);
  }
});

test("missing and disabled account owners cannot authorize an upload", async () => {
  for (const change of [
    f => { delete f.state.users.alice; },
    f => { f.state.users.alice.enabled = false; },
    f => { f.state.users.alice.enabled = "true"; },
  ]) {
    const f = fixture();
    change(f);
    assert.deepEqual(await f.store.authenticate(token), { ok: false, status: 401,
      code: "account_disabled", message: "Bu API anahtarının bağlı olduğu hesap kullanıma kapalı." });
    assert.equal(f.writes(), 0);
  }
});

test("authentication uses fresh state and reserve rechecks revocation after the upload", async () => {
  const f = fixture();
  assert.deepEqual(await f.store.authenticate(token), { ok: true });
  delete f.state.keys[digest];
  assert.equal((await f.store.authenticate(token)).code, "invalid_api_key");
  assert.equal((await f.store.reserve(token, { estimatedTokens: 500 })).code, "invalid_api_key");
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.state.reservations, {});
  assert.deepEqual(f.state.usage, {});
});

test("reserve rechecks account disablement and key expiration after authentication", async () => {
  for (const change of [
    f => { f.state.users.alice.enabled = false; },
    f => { f.setNow(f.state.keys[digest].expires_at); },
  ]) {
    const f = fixture();
    assert.deepEqual(await f.store.authenticate(token), { ok: true });
    change(f);
    const result = await f.store.reserve(token, { estimatedTokens: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.deepEqual(f.state.reservations, {});
    assert.deepEqual(f.state.usage, {});
  }
});

test("storage unavailability fails closed without an authentication success", async () => {
  const failure = Object.assign(new Error("read unavailable"), { statusCode: 503, code: "read_unavailable" });
  const store = createKeyStore({ async readState() { throw failure; },
    async mutateState() { assert.fail("Authentication must not write storage"); } });
  await assert.rejects(store.authenticate(token), error => error === failure);
});
