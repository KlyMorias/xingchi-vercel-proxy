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
