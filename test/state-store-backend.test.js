const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { BlobPreconditionFailedError } = require("@vercel/blob");
const { createPostgresBlob, PATH } = require("../lib/postgres-blob");
const { createStateStore, isConfigured } = require("../lib/state-store");

const originalEnv = { ...process.env };
test.beforeEach(() => {
  delete process.env.DATABASE_URL;
  delete process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.ADMIN_USERNAME = "TestAdmin";
  process.env.ADMIN_PASSWORD_HASH = `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`;
});
test.afterEach(() => { process.env = { ...originalEnv }; });

function stateText() {
  return JSON.stringify({ version: 1, users: {}, sessions: {}, keys: {},
    usage: { counter: { used: 0 } }, reservations: {}, login_attempts: {} });
}

function memoryClient(initial = stateText()) {
  let text = initial;
  let revision = initial === null ? 0 : 1;
  return {
    calls: [],
    async get(path, options) {
      this.calls.push({ operation: "get", path, options });
      if (text === null) return null;
      return { statusCode: 200, blob: { etag: String(revision), size: Buffer.byteLength(text) },
        stream: new Response(text).body };
    },
    async put(path, next, options) {
      this.calls.push({ operation: "put", path, options });
      if (text !== null && (!options.allowOverwrite || options.ifMatch !== String(revision))) {
        throw new BlobPreconditionFailedError();
      }
      text = next;
      return { etag: String(++revision) };
    },
  };
}

// Replace only this module's two backend imports during synchronous loading.
// Each test exercises the real module-level default without network requests.
function loadWithBackends(blobClient, postgresFactory) {
  const filename = require.resolve("../lib/state-store");
  const previousModule = require.cache[filename];
  const previousLoad = Module._load;
  delete require.cache[filename];
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === filename) {
      if (request === "@vercel/blob") return { ...blobClient, BlobPreconditionFailedError };
      if (request === "./postgres-blob") return { createPostgresBlob: postgresFactory };
    }
    return previousLoad.call(this, request, parent, ...rest);
  };
  try { return require(filename); }
  finally {
    Module._load = previousLoad;
    if (previousModule) require.cache[filename] = previousModule;
    else delete require.cache[filename];
  }
}

test("DATABASE_URL configures account storage without Blob credentials", () => {
  assert.equal(isConfigured(), false);
  process.env.DATABASE_URL = "postgresql://test.invalid/test";
  assert.equal(isConfigured(), true);
  delete process.env.DATABASE_URL;
  process.env.BLOB_STORE_ID = "store_test";
  assert.equal(isConfigured(), true);
  delete process.env.BLOB_STORE_ID;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  assert.equal(isConfigured(), true);
});

test("default and factory stores prefer PostgreSQL and exclude all Blob-only options", async () => {
  process.env.DATABASE_URL = "postgresql://test.invalid/test";
  process.env.BLOB_STORE_ID = "store_unused";
  process.env.BLOB_READ_WRITE_TOKEN = "unused-blob-token";
  const blobClient = memoryClient();
  const postgresClient = Object.assign(memoryClient(), { requiresMigration: true });
  let factories = 0;
  const storage = loadWithBackends(blobClient, (...args) => {
    assert.equal(args.length, 0);
    factories++;
    return postgresClient;
  });
  assert.equal(storage.isConfigured(), true);
  assert.equal((await storage.readState()).usage.counter.used, 0);
  assert.equal(await storage.mutateState((state) => ++state.usage.counter.used), 1);
  assert.equal((await storage.createStateStore().readState()).usage.counter.used, 1);
  assert.equal(factories, 2);
  assert.equal(blobClient.calls.length, 0);
  for (const call of postgresClient.calls) {
    assert.equal(call.path, PATH);
    assert.ok(call.options.abortSignal instanceof AbortSignal);
    assert.deepEqual(Object.keys(call.options).sort(), call.operation === "get"
      ? ["abortSignal"] : ["abortSignal", "allowOverwrite", "ifMatch"]);
    if (call.operation === "put") {
      assert.equal(call.options.allowOverwrite, true);
      assert.equal(call.options.ifMatch, "1");
    }
  }
});

for (const credential of ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"]) {
  test(`without DATABASE_URL the default retains Blob ${credential} options`, async () => {
    process.env[credential] = credential === "BLOB_STORE_ID" ? "store_test" : "test-token";
    const client = memoryClient();
    const storage = loadWithBackends(client, () => { throw new Error("PostgreSQL must not be selected"); });
    assert.equal((await storage.readState()).version, 1);
    assert.equal(await storage.mutateState((state) => ++state.usage.counter.used), 1);
    assert.equal((await storage.createStateStore().readState()).usage.counter.used, 1);
    for (const call of client.calls) {
      assert.equal(call.options.access, "private");
      assert.ok(call.options.abortSignal instanceof AbortSignal);
      assert.equal(call.options[credential === "BLOB_STORE_ID" ? "storeId" : "token"], process.env[credential]);
      if (call.operation === "get") {
        assert.equal(call.options.useCache, false);
        assert.equal(call.options.headers["accept-encoding"], "identity");
      } else {
        assert.equal(call.options.addRandomSuffix, false);
        assert.equal(call.options.contentType, "application/json");
        assert.equal(call.options.cacheControlMaxAge, 60);
        assert.equal(call.options.ifMatch, "1");
      }
    }
  });
}

test("a missing PostgreSQL singleton never seeds accounts or falls back to Blob", async () => {
  process.env.DATABASE_URL = "postgresql://test.invalid/test";
  process.env.BLOB_READ_WRITE_TOKEN = "unused-blob-token";
  const blobClient = memoryClient();
  const queries = [];
  const client = createPostgresBlob(async (sql, params) => { queries.push({ sql, params }); return []; });
  assert.equal(client.requiresMigration, true);
  const storage = loadWithBackends(blobClient, () => client);
  let callbacks = 0;
  await assert.rejects(storage.readState(), { status: 503, code: "storage_unavailable" });
  await assert.rejects(storage.mutateState(() => { callbacks++; }), { status: 503, code: "storage_unavailable" });
  assert.equal(callbacks, 0);
  assert.equal(blobClient.calls.length, 0);
  assert.equal(queries.length, 2);
  assert.ok(queries.every(({ sql, params }) => sql.startsWith("SELECT") && params[0] === PATH));
});

test("an injected Blob client retains initial seeding even when DATABASE_URL is configured", async () => {
  process.env.DATABASE_URL = "postgresql://test.invalid/test";
  const client = memoryClient(null);
  const storage = createStateStore(client);
  const state = await storage.readState();
  assert.equal(state.users.testadmin.password_hash, process.env.ADMIN_PASSWORD_HASH);
  assert.equal((await storage.readState()).users.testadmin.id, state.users.testadmin.id);
  assert.equal(client.calls.filter((call) => call.operation === "put").length, 1);
  assert.equal(client.calls.find((call) => call.operation === "put").options.allowOverwrite, false);
});

test("a PostgreSQL singleton removed during a CAS conflict is never recreated", async () => {
  process.env.DATABASE_URL = "postgresql://test.invalid/test";
  const queries = [];
  let present = true;
  const client = createPostgresBlob(async (sql) => {
    queries.push(sql);
    if (sql.startsWith("SELECT")) return present ? [{ payload: stateText(), version: "1" }] : [];
    assert.match(sql, /^UPDATE/);
    present = false;
    return [];
  });
  const storage = createStateStore(client, { pause: async () => {}, warn: () => {} });
  let callbacks = 0;
  await assert.rejects(storage.mutateState((state) => { callbacks++; return ++state.usage.counter.used; }),
    { status: 503, code: "storage_unavailable" });
  assert.equal(callbacks, 1);
  assert.equal(present, false);
  assert.deepEqual(queries.map((sql) => sql.split(" ")[0]), ["SELECT", "UPDATE", "SELECT"]);
});
