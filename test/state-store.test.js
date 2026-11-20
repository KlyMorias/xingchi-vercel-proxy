const test = require("node:test");
const assert = require("node:assert/strict");
const { createStateStore } = require("../lib/state-store");
const originalEnv = { ...process.env };
test.afterEach(() => { process.env = { ...originalEnv }; });

function memoryBlob() {
  let text = null;
  let revision = 0;
  const calls = [];
  return { calls, async get(_path, options) {
    calls.push({ operation: "get", options });
    if (text === null) return null;
    return { statusCode: 200, blob: { etag: `rev-${revision}`, size: Buffer.byteLength(text) }, stream: new Response(text).body };
  }, async put(_path, value, options) {
    calls.push({ operation: "put", options });
    if (text !== null && (!options.allowOverwrite || options.ifMatch !== `rev-${revision}`)) {
      throw new Error("precondition failed");
    }
    text = value; revision++;
    return { etag: `rev-${revision}` };
  } };
}

function configure() {
  process.env.BLOB_STORE_ID = "store_test";
  process.env.ADMIN_USERNAME = "TestAdmin";
  process.env.ADMIN_PASSWORD_HASH = `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`;
}

test("initializes private account storage once with only a password hash", async () => {
  configure();
  const client = memoryBlob();
  const store = createStateStore(client);
  const [first, second] = await Promise.all([store.readState(), store.readState()]);
  assert.equal(first.users.testadmin.password_hash, process.env.ADMIN_PASSWORD_HASH);
  assert.equal(first.users.testadmin.id, second.users.testadmin.id);
  for (const call of client.calls) {
    assert.equal(call.options.access, "private");
    if (call.operation === "get") {
      assert.equal(call.options.useCache, false);
      assert.equal(call.options.headers["accept-encoding"], "identity");
    }
  }
});

test("concurrent mutations retry compare-and-swap instead of losing updates", async () => {
  configure();
  const client = memoryBlob();
  const store = createStateStore(client, { attempts: 20, pause: async () => {} });
  await store.readState();
  await Promise.all(Array.from({ length: 8 }, () => store.mutateState((draft) => {
    draft.usage.test = { used: (draft.usage.test?.used || 0) + 1 };
  })));
  assert.equal((await store.readState()).usage.test.used, 8);
  const updates = client.calls.filter((call) => call.operation === "put" && call.options.allowOverwrite);
  assert.ok(updates.length >= 8);
  assert.ok(updates.every((call) => call.options.ifMatch));
});

test("an unavailable or corrupt store never resets existing accounts", async () => {
  configure();
  let writes = 0;
  const store = createStateStore({ async get() { return { statusCode: 200, blob: { etag: "x" }, stream: new Response('{"broken":true}').body }; }, async put() { writes++; } });
  await assert.rejects(store.readState(), { status: 503 });
  assert.equal(writes, 0);
});

test("expired credentials and tickets are cleaned during a durable mutation", async () => {
  configure();
  const store = createStateStore(memoryBlob());
  await store.mutateState((draft) => { draft.sessions.expired = { expires_at: 1 }; });
  await store.mutateState((draft) => { draft.usage.active = { used: 2 }; });
  assert.equal((await store.readState()).sessions.expired, undefined);
});

test("transient Blob reads retry without logging SDK messages or stored data", async () => {
  configure();
  const client = memoryBlob();
  await createStateStore(client).readState();
  const get = client.get.bind(client);
  const logs = [];
  let attempts = 0;
  const failures = [
    Object.assign(new Error("private request endpoint and token"), { status: 429 }),
    Object.assign(new Error("Failed to fetch blob: 503 Service Unavailable"), { status: 503 }),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    Object.assign(new Error("private timeout detail"), { name: "TimeoutError" }),
  ];
  for (const failure of failures) {
    attempts = 0;
    client.get = async (...args) => { if (++attempts === 1) throw failure; return get(...args); };
    const store = createStateStore(client, { pause: async () => {}, warn: (entry) => logs.push(entry) });
    assert.equal((await store.readState()).version, 1);
    assert.equal(attempts, 2);
  }
  assert.deepEqual(logs.map((entry) => entry.reason), ["ratelimit", "unavailable", "network", "network"]);
  assert.ok(logs.every((entry) => Object.keys(entry).sort().join(",") === "attempt,phase,reason,scope"));
  assert.equal(JSON.stringify(logs).includes("private"), false);
});

test("explicit write throttling retries but ambiguous network writes do not", async () => {
  configure();
  const client = memoryBlob();
  await createStateStore(client).readState();
  const put = client.put.bind(client);
  const logs = [];
  let writes = 0;
  client.put = async (...args) => {
    if (++writes === 1) throw Object.assign(new Error("private rate-limit detail"), { statusCode: 429 });
    return put(...args);
  };
  const store = createStateStore(client, { pause: async () => {}, warn: (entry) => logs.push(entry) });
  await store.mutateState((draft) => { draft.usage.rate = { used: 1 }; });
  assert.equal(writes, 2);
  assert.equal((await store.readState()).usage.rate.used, 1);
  assert.deepEqual(logs, [{ scope: "storage", phase: "write", reason: "ratelimit", attempt: 1 }]);

  writes = 0;
  client.put = async () => { writes++; throw new TypeError("fetch failed"); };
  await assert.rejects(store.mutateState((draft) => { draft.usage.rate.used++; }), { code: "write_unavailable" });
  assert.equal(writes, 1);
  assert.equal((await store.readState()).usage.rate.used, 1);
});

test("auth and corrupt-data failures do not retry or reset accounts", async () => {
  configure();
  const failures = [Object.assign(new Error("Failed to fetch blob: 403 Forbidden"), { status: 403 }),
    new SyntaxError("private JSON content"), Object.assign(new Error("invalid token"), { status: 401 })];
  for (const cause of failures) {
    let reads = 0;
    let writes = 0;
    const logs = [];
    const store = createStateStore({ async get() { reads++; throw cause; }, async put() { writes++; } },
      { pause: async () => {}, warn: (entry) => logs.push(entry) });
    await assert.rejects(store.readState(), { code: "read_unavailable" });
    assert.equal(reads, 1);
    assert.equal(writes, 0);
    assert.equal(logs[0].reason, cause instanceof SyntaxError ? "invalid" : "auth");
  }
});

test("read and write retry counts are bounded and long retry-after never exceeds the budget", async () => {
  configure();
  let reads = 0;
  let pauses = 0;
  const store = createStateStore({ async get() { reads++; throw Object.assign(new Error("unavailable"), { status: 503 }); } },
    { pause: async () => { pauses++; }, warn: () => {} });
  await assert.rejects(store.readState(), { code: "read_unavailable" });
  assert.equal(reads, 3);
  assert.equal(pauses, 2);

  const client = memoryBlob();
  await createStateStore(client).readState();
  let writes = 0;
  client.put = async () => { writes++; throw Object.assign(new Error("throttled"), { status: 429 }); };
  const writeStore = createStateStore(client, { pause: async () => {}, warn: () => {} });
  await assert.rejects(writeStore.mutateState((draft) => { draft.usage.limit = { used: 1 }; }), { code: "write_unavailable" });
  assert.equal(writes, 5);

  writes = 0;
  pauses = 0;
  client.put = async () => { writes++; throw Object.assign(new Error("throttled"), { status: 429, retryAfter: 20 }); };
  const backoffStore = createStateStore(client, { pause: async () => { pauses++; }, warn: () => {} });
  await assert.rejects(backoffStore.mutateState((draft) => { draft.usage.limit = { used: 1 }; }), { code: "write_unavailable" });
  assert.equal(writes, 1);
  assert.equal(pauses, 0);
});

test("CAS exhaustion preserves storage_busy and safe sequential conflict counts", async () => {
  configure();
  const client = memoryBlob();
  await createStateStore(client).readState();
  client.put = async () => { throw new Error("precondition failed"); };
  const logs = [];
  const store = createStateStore(client, { attempts: 3, pause: async () => {}, warn: (entry) => logs.push(entry) });
  await assert.rejects(store.mutateState((draft) => { draft.usage.cas = { used: 1 }; }), { code: "storage_busy", retryAfter: 2 });
  assert.deepEqual(logs.map((entry) => entry.attempt), [1, 2, 3]);
  assert.ok(logs.every((entry) => entry.reason === "conflict" && entry.phase === "write"));
});
