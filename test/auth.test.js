const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { createAuth, hashPassword, verifyPassword } = require("../lib/auth");
const authApi = require("../api/auth");
const usersApi = require("../api/users");

const initialSecret = process.env.KEY_HASH_SECRET;
let seededHash;
let fixture;

function response() {
  return { statusCode: 200, headers: {}, body: "", setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value || ""; } };
}

function request({ method = "POST", body = {}, cookie, headers = {}, ip = "192.0.2.10", rawBody } = {}) {
  const text = rawBody ?? JSON.stringify(body);
  return { method, headers: { host: "klyapi.vercel.app", origin: "https://klyapi.vercel.app", "content-type": "application/json",
    ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: ip },
  async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text); } };
}

function cookieFrom(res) { return res.headers["set-cookie"].split(";")[0]; }

function memoryStore() {
  let state = { version: 1, users: { klymorias: { id: "admin-id", username: "KlyMorias", role: "admin", enabled: true,
    password_hash: seededHash, session_version: 1, daily_limit: 50, requests_per_minute: 5, created_at: "2026-11-20T00:00:00.000Z" } },
  sessions: {}, keys: {}, usage: {}, reservations: {}, login_attempts: {} };
  return {
    readState: async () => structuredClone(state),
    mutateState: async (callback) => {
      const draft = structuredClone(state);
      const result = callback(draft);
      assert.equal(typeof result?.then, "undefined", "A CAS mutation must be synchronous");
      state = draft;
      return structuredClone(result);
    },
    snapshot: () => structuredClone(state),
    edit: (callback) => callback(state),
  };
}

async function login(username = "KlyMorias", password = "valid-password", options = {}) {
  const res = response();
  await fixture.authHandler(request({ body: { action: "login", username, password }, ...options }), res);
  return res;
}

async function makeUser(adminCookie, username = "Guest_1", password = "guest-password") {
  const res = response();
  await fixture.usersHandler(request({ cookie: adminCookie, body: { username, password } }), res);
  assert.equal(res.statusCode, 201);
  return JSON.parse(res.body).user;
}

test.before(async () => { seededHash = await hashPassword("valid-password"); });
test.beforeEach(() => {
  process.env.KEY_HASH_SECRET = "h".repeat(64);
  const store = memoryStore();
  const auth = createAuth(store);
  fixture = { store, auth, authHandler: authApi.createHandler(auth), usersHandler: usersApi.createHandler(auth) };
});
test.after(() => {
  if (initialSecret === undefined) delete process.env.KEY_HASH_SECRET;
  else process.env.KEY_HASH_SECRET = initialSecret;
});

test("password hashing matches the bootstrap ASCII salt format and checks credentials", async () => {
  const salt = "a".repeat(32);
  const hash = await promisify(crypto.scrypt)("bootstrap-password", salt, 64, { N: 16384, r: 8, p: 1 });
  assert.equal(await verifyPassword("bootstrap-password", `scrypt$${salt}$${hash.toString("hex")}`), true);
  assert.equal(await verifyPassword("wrong-password", seededHash), false);
  assert.equal(await verifyPassword("valid-password", "not-a-hash"), false);
  assert.notEqual(await hashPassword("valid-password"), seededHash);
  await assert.rejects(hashPassword("short"), { status: 400 });
});

test("login creates a hashed opaque secure session and returns no private fields", async () => {
  const res = await login("KLYMORIAS");
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["set-cookie"], /^kly_auth=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict$/);
  const result = JSON.parse(res.body);
  assert.equal(result.user.username, "KlyMorias");
  assert.equal(result.user.role, "admin");
  assert.equal(result.user.password_hash, undefined);
  assert.equal(result.user.session_version, undefined);
  assert.equal(result.user.id, undefined);
  const token = cookieFrom(res).slice("kly_auth=".length);
  const state = fixture.store.snapshot();
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.ok(state.sessions[crypto.createHash("sha256").update(token).digest("hex")]);
  assert.equal(JSON.stringify(state).includes(token), false);
  assert.equal(JSON.stringify(state.login_attempts).includes("192.0.2.10"), false);
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("authentication rejects missing, expired and version-invalidated sessions", async () => {
  await assert.rejects(fixture.auth.requireUser(request()), { status: 401 });
  const res = await login();
  const req = request({ cookie: cookieFrom(res) });
  const user = await fixture.auth.requireUser(req);
  assert.equal(user.id, "admin-id");
  assert.equal(user.password_hash, undefined);
  fixture.store.edit((state) => { state.users.klymorias.session_version++; });
  await assert.rejects(fixture.auth.requireUser(req), { status: 401 });
  fixture.store.edit((state) => {
    state.users.klymorias.session_version--;
    Object.values(state.sessions)[0].expires_at = Math.floor(Date.now() / 1000) - 1;
  });
  await assert.rejects(fixture.auth.requireUser(req), { status: 401 });
});

test("failed login is uniform and throttles all usernames from the same IP", async () => {
  for (let i = 0; i < 10; i++) {
    const res = await login(i % 2 ? "missing_user" : "KlyMorias", "wrong-password");
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error.code, "invalid_credentials");
    assert.equal(res.headers["set-cookie"], undefined);
  }
  const rejected = await login("another_username", "wrong-password");
  assert.equal(rejected.statusCode, 429);
  assert.ok(Number(rejected.headers["retry-after"]) > 0);
  assert.equal(Object.values(fixture.store.snapshot().login_attempts).some((entry) => entry.count > 10), false);
});

test("mutating requests reject cross-origin, invalid and oversized bodies without side effects", async () => {
  for (const options of [
    { headers: { origin: "https://other.example" } },
    { headers: { origin: undefined } },
    { headers: { "sec-fetch-site": "cross-site" } },
  ]) {
    const res = await login("KlyMorias", "valid-password", options);
    assert.equal(res.statusCode, 403);
  }
  const invalid = response();
  await fixture.authHandler(request({ rawBody: "[]" }), invalid);
  assert.equal(invalid.statusCode, 400);
  const oversized = response();
  await fixture.authHandler(request({ body: { action: "login", password: "x".repeat(8192) } }), oversized);
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(fixture.store.snapshot().login_attempts, {});
});

test("runtime lazy JSON fallback supports login while hiding parser errors", async () => {
  const req = request({ rawBody: "" });
  req.body = { action: "login", username: "KlyMorias", password: "valid-password" };
  const res = response();
  await fixture.authHandler(req, res);
  assert.equal(res.statusCode, 200);
  const badReq = request({ rawBody: "" });
  Object.defineProperty(badReq, "body", { get() { throw new Error("private parser error"); } });
  const badRes = response();
  await fixture.authHandler(badReq, badRes);
  assert.equal(badRes.statusCode, 400);
  assert.equal(badRes.body.includes("private parser error"), false);
});

test("logout removes the durable session and clears its cookie", async () => {
  const logged = await login();
  const cookie = cookieFrom(logged);
  const res = response();
  await fixture.authHandler(request({ cookie, body: { action: "logout" } }), res);
  assert.equal(res.statusCode, 204);
  assert.match(res.headers["set-cookie"], /Max-Age=0/);
  await assert.rejects(fixture.auth.requireUser(request({ cookie })), { status: 401 });
});

test("password changes invalidate all older sessions and preserve the current login", async () => {
  const first = await login();
  const second = await login();
  const res = response();
  await fixture.authHandler(request({ cookie: cookieFrom(first), body: {
    action: "password", current_password: "valid-password", new_password: "new-password-long",
  } }), res);
  assert.equal(res.statusCode, 200);
  for (const old of [first, second]) {
    await assert.rejects(fixture.auth.requireUser(request({ cookie: cookieFrom(old) })), { status: 401 });
  }
  assert.equal((await fixture.auth.requireUser(request({ cookie: cookieFrom(res) }))).username, "KlyMorias");
  assert.equal(fixture.store.snapshot().users.klymorias.session_version, 2);
  assert.equal((await login("KlyMorias", "valid-password")).statusCode, 401);
  assert.equal((await login("KlyMorias", "new-password-long")).statusCode, 200);
});

test("only admins can create accounts and all username lookups are case-insensitive", async () => {
  const unauthenticated = response();
  await fixture.usersHandler(request({ body: { username: "Guest_1", password: "guest-password" } }), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  const admin = await login();
  await makeUser(cookieFrom(admin));
  const duplicate = response();
  await fixture.usersHandler(request({ cookie: cookieFrom(admin), body: {
    username: "GUEST_1", password: "guest-password",
  } }), duplicate);
  assert.equal(duplicate.statusCode, 409);
  const guest = await login("guest_1", "guest-password");
  assert.equal(guest.statusCode, 200);
  const forbidden = response();
  await fixture.usersHandler(request({ method: "GET", cookie: cookieFrom(guest) }), forbidden);
  assert.equal(forbidden.statusCode, 403);
  const escalation = response();
  await fixture.usersHandler(request({ method: "PATCH", cookie: cookieFrom(admin), body: {
    username: "Guest_1", role: "admin",
  } }), escalation);
  assert.equal(escalation.statusCode, 400);
});

test("admin-created accounts have private hashes and configurable bounded limits", async () => {
  const admin = await login();
  const res = response();
  await fixture.usersHandler(request({ cookie: cookieFrom(admin), body: {
    username: "Guest_1", password: "guest-password", daily_limit: 120, requests_per_minute: 12,
  } }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(JSON.parse(res.body).user.daily_limit, 120);
  const stored = fixture.store.snapshot().users.guest_1;
  assert.notEqual(stored.password_hash, "guest-password");
  assert.equal(await verifyPassword("guest-password", stored.password_hash), true);
  const listed = response();
  await fixture.usersHandler(request({ method: "GET", cookie: cookieFrom(admin) }), listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.includes(stored.password_hash), false);
  assert.equal(listed.body.includes("session_version"), false);
  for (const payload of [{ daily_limit: 0 }, { requests_per_minute: 1001 }, { password: "short" }]) {
    const invalid = response();
    await fixture.usersHandler(request({ cookie: cookieFrom(admin), body: { username: "Guest_2", password: "guest-password", ...payload } }), invalid);
    assert.equal(invalid.statusCode, 400);
  }
});

test("disabling or resetting a user revokes their sessions without affecting the admin", async () => {
  const admin = await login();
  const adminCookie = cookieFrom(admin);
  await makeUser(adminCookie);
  const guest = await login("Guest_1", "guest-password");
  const disabled = response();
  await fixture.usersHandler(request({ method: "PATCH", cookie: adminCookie, body: { username: "Guest_1", enabled: false } }), disabled);
  assert.equal(disabled.statusCode, 200);
  await assert.rejects(fixture.auth.requireUser(request({ cookie: cookieFrom(guest) })), { status: 401 });
  assert.equal((await login("Guest_1", "guest-password")).statusCode, 401);
  const reset = response();
  await fixture.usersHandler(request({ method: "PATCH", cookie: adminCookie, body: {
    username: "Guest_1", enabled: true, password: "reset-password",
  } }), reset);
  assert.equal(reset.statusCode, 200);
  assert.equal((await login("Guest_1", "reset-password")).statusCode, 200);
  for (const patch of [{ enabled: false }, { password: "change-admin-pass" }]) {
    const protectedAdmin = response();
    await fixture.usersHandler(request({ method: "PATCH", cookie: adminCookie, body: { username: "KlyMorias", ...patch } }), protectedAdmin);
    assert.equal(protectedAdmin.statusCode, 403);
  }
  assert.equal((await fixture.auth.requireUser(request({ cookie: adminCookie }))).role, "admin");
});

test("reserved usernames and prototype keys cannot create accounts", async () => {
  const admin = await login();
  for (const username of ["__proto__", "constructor", "prototype"]) {
    const res = response();
    await fixture.usersHandler(request({ cookie: cookieFrom(admin), body: { username, password: "guest-password" } }), res);
    assert.equal(res.statusCode, 400);
    const denied = await login(username, "guest-password");
    assert.equal(denied.statusCode, 401);
  }
  assert.equal(Object.keys(fixture.store.snapshot().users).length, 1);
  assert.equal({}.password_hash, undefined);
});

test("limits durable user count and sessions without resetting the account", async () => {
  const admin = await login();
  fixture.store.edit((state) => {
    for (let i = 0; i < 99; i++) state.users[`member_${i}`] = { ...state.users.klymorias,
      id: `id-${i}`, username: `member_${i}`, role: "user" };
  });
  const full = response();
  await fixture.usersHandler(request({ cookie: cookieFrom(admin), body: { username: "OverLimit", password: "guest-password" } }), full);
  assert.equal(full.statusCode, 409);
  for (let i = 0; i < 11; i++) assert.equal((await login("KlyMorias", "valid-password", { ip: `192.0.2.${20 + i}` })).statusCode, 200);
  assert.equal(Object.values(fixture.store.snapshot().sessions).filter((session) => session.user_id === "admin-id").length, 10);
});

test("storage errors are closed and do not leak internal diagnostics", async () => {
  const failure = createAuth({
    readState: async () => { throw new Error("private blob diagnostic"); },
    mutateState: async () => { throw new Error("private blob diagnostic"); },
  });
  const res = response();
  await authApi.createHandler(failure)(request({ method: "GET" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.includes("private blob diagnostic"), false);
  assert.equal(JSON.parse(res.body).error.code, "storage_unavailable");
});
