const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const store = require("../lib/key-store.js");
const handler = require("../api/keys.js");

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
const session = "a".repeat(43);
const apiToken = `kly_${"b".repeat(43)}`;

function response() {
  return { statusCode: 200, headers: {}, body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body || ""; },
  };
}

function request({ method = "GET", body = "{}", headers = {}, cookie = session } = {}) {
  return { method, headers: { host: "klyapi.vercel.app", origin: "https://klyapi.vercel.app",
    "content-type": "application/json", ...(cookie ? { cookie: `kly_session=${cookie}` } : {}), ...headers },
  socket: { remoteAddress: "192.0.2.10" },
  async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
}

function redisMock(reply) {
  const calls = [];
  global.fetch = async (url, options) => {
    const command = JSON.parse(options.body);
    calls.push({ url, options, command });
    const result = typeof reply === "function" ? await reply(command, calls.length) : reply;
    return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } });
  };
  return calls;
}

test.beforeEach(() => {
  for (const name of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "KEY_HASH_SECRET"]) {
    delete process.env[name];
  }
  process.env.KV_REST_API_URL = "https://test-redis.upstash.io";
  process.env.KV_REST_API_TOKEN = "redis-secret";
  process.env.KEY_HASH_SECRET = "h".repeat(64);
});

test.afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });

test("fails closed when hashing secret or durable storage is absent", async () => {
  delete process.env.KEY_HASH_SECRET;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error("unexpected call"); };
  assert.equal(store.isConfigured(), false);
  await assert.rejects(store.reserve(apiToken), { status: 503, code: "storage_unavailable" });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
});

test("supports Upstash credentials and creates an opaque secure anonymous session", async () => {
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = "https://other-redis.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "other-secret";
  const calls = redisMock([0]);
  const res = response();
  await handler(request({ cookie: null }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].url, "https://other-redis.upstash.io");
  assert.equal(calls[0].options.headers.authorization, "Bearer other-secret");
  assert.match(res.headers["set-cookie"], /^kly_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
  assert.deepEqual(JSON.parse(res.body), {
    key: null, limits: { daily_requests: 50, requests_per_minute: 5 },
    service: { model: "gpt-6.1-sol", generation_available: true,
      message: "gpt-6.1-sol erişimi açık. OpenAI veya Anthropic uyumlu uygulamanı bağlayabilirsin." },
  });
  assert.equal(res.headers["cache-control"], "private, no-store");
});

test("reveals a new API token once while persisting only its hash and short prefix", async () => {
  let persisted;
  const calls = redisMock((command, index) => {
    if (index === 1) {
      persisted = command.slice(3 + command[2])[2];
      return [1, persisted, 7];
    }
    return [1, persisted, 7];
  });
  const res = response();
  await handler(request({ method: "POST", headers: { "x-vercel-forwarded-for": "198.51.100.24" } }), res);
  assert.equal(res.statusCode, 201);
  const created = JSON.parse(res.body);
  assert.match(created.api_key, /^kly_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.key.prefix, created.api_key.slice(0, 12));
  assert.equal(created.key.used_today, 7);
  assert.equal(created.key.remaining_today, 43);
  assert.equal(Date.parse(created.key.expires_at) - Date.parse(created.key.created_at), 30 * 86400 * 1000);
  const sent = calls[0].options.body;
  assert.equal(sent.includes(created.api_key), false);
  assert.equal(sent.includes("198.51.100.24"), false);
  assert.equal(sent.includes(session), false);
  assert.ok(calls[0].command.includes(`kly:key:${store.hashToken(created.api_key)}`));

  const getRes = response();
  await handler(request(), getRes);
  const fetched = JSON.parse(getRes.body);
  assert.equal(fetched.api_key, undefined);
  assert.equal(getRes.body.includes(created.api_key), false);
  assert.deepEqual(fetched.key, created.key);
});

test("rejects simultaneous active-key conflicts and issuance limits from Redis", async () => {
  redisMock([0, 409, "active_key_exists", 0]);
  const conflict = response();
  await handler(request({ method: "POST" }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).error.code, "active_key_exists");
  redisMock([0, 429, "creation_limit_exceeded", 300]);
  const limited = response();
  await handler(request({ method: "POST" }), limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["retry-after"], "300");
  assert.equal(JSON.parse(limited.body).api_key, undefined);
});

test("mutation requires same origin and a bounded JSON body before storage access", async () => {
  const calls = redisMock([1]);
  const crossOrigin = response();
  await handler(request({ method: "DELETE", headers: { origin: "https://untrusted.example" } }), crossOrigin);
  assert.equal(crossOrigin.statusCode, 403);
  const noOrigin = response();
  await handler(request({ method: "POST", headers: { origin: undefined } }), noOrigin);
  assert.equal(noOrigin.statusCode, 403);
  const plain = response();
  await handler(request({ method: "POST", headers: { "content-type": "text/plain" } }), plain);
  assert.equal(plain.statusCode, 415);
  const oversized = response();
  await handler(request({ method: "POST", body: JSON.stringify({ value: "x".repeat(1024) }) }), oversized);
  assert.equal(oversized.statusCode, 413);
  const invalid = response();
  await handler(request({ method: "POST", body: "[]" }), invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("revocation is a single durable operation and retains owner quota counters", async () => {
  const calls = redisMock([1]);
  const res = response();
  await handler(request({ method: "DELETE" }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, "");
  assert.equal(calls.length, 1);
  const command = calls[0].command;
  assert.equal(command[0], "EVAL");
  assert.equal(command[2], 1);
  assert.match(command[3], /^kly:owner:[a-f0-9]{64}$/);
  assert.equal(command[1].includes("kly:day:"), false);
  assert.equal(command[1].includes("kly:minute:"), false);
});

test("accepts a lazily parsed runtime body after its raw stream was consumed", async () => {
  redisMock((command) => [1, command.slice(3 + command[2])[2], 0]);
  const req = request({ method: "POST", body: "" });
  let reads = 0;
  Object.defineProperty(req, "body", { get() { reads++; return {}; } });
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(reads, 1);
});

test("malformed lazy runtime JSON remains a client error and never reaches Redis", async () => {
  const calls = redisMock([1]);
  const req = request({ method: "POST", body: "" });
  Object.defineProperty(req, "body", { get() { throw new SyntaxError("private parse detail"); } });
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal(res.body.includes("private parse detail"), false);
});

test("auth and quota failures use one atomic REST decision with useful backoff", async () => {
  const calls = redisMock([0, 429, "daily_limit_exceeded", 900]);
  const daily = await store.reserve(apiToken, { consumeDaily: true });
  assert.equal(daily.status, 429);
  assert.equal(daily.code, "daily_limit_exceeded");
  assert.equal(daily.retryAfter, 900);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command[0], "EVAL");
  assert.equal(calls[0].command[2], 2);
  assert.equal(calls[0].command[3], `kly:key:${crypto.createHash("sha256").update(apiToken).digest("hex")}`);
  assert.equal(calls[0].options.body.includes(apiToken), false);
  assert.equal(calls[0].options.cache, "no-store");
  redisMock([0, 429, "rate_limited", 15]);
  assert.equal((await store.reserve(apiToken)).retryAfter, 15);
  redisMock([0, 401, "invalid_api_key", 0]);
  assert.equal((await store.reserve(apiToken)).status, 401);
});

test("daily refunds use opaque idempotent reservation IDs and models do not reserve daily quota", async () => {
  const calls = redisMock([1, 11, 39]);
  const accepted = await store.reserve(apiToken);
  assert.equal(accepted.ok, true);
  assert.match(accepted.reservation.id, /^[a-f0-9]{32}$/);
  assert.equal(accepted.remainingToday, 39);
  const releaseCalls = redisMock((_command, index) => index === 1 ? [1] : [0]);
  await store.release(accepted.reservation);
  await store.release(accepted.reservation);
  assert.equal(releaseCalls[0].command[3], `kly:reservation:${accepted.reservation.id}`);
  assert.deepEqual(releaseCalls[0].command, releaseCalls[1].command);
  assert.equal(calls.length, 1);
  const modelCalls = redisMock([1, 11, 39]);
  const models = await store.reserve(apiToken, { consumeDaily: false });
  assert.equal(models.reservation, null);
  const args = modelCalls[0].command.slice(3 + modelCalls[0].command[2]);
  assert.equal(args[5], "0");
  await store.release(models.reservation);
  assert.equal(modelCalls.length, 1);
});

test("storage transport and Redis command errors fail closed without leaking details", async () => {
  for (const fail of [
    async () => { throw new Error("private transport detail"); },
    async () => new Response("redis-secret", { status: 500 }),
    async () => new Response(JSON.stringify({ error: "redis-secret" })),
    async () => new Response(JSON.stringify({ result: null })),
  ]) {
    global.fetch = fail;
    await assert.rejects(store.reserve(apiToken), { status: 503, code: "storage_unavailable" });
    const res = response();
    await handler(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.includes("redis-secret"), false);
    assert.equal(res.body.includes("private transport detail"), false);
  }
});
